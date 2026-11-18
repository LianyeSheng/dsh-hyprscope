/*
 * wl-capture: list foreign toplevels and capture one of them through
 * ext-image-copy-capture.
 *
 * This helper is the non-grim capture path: it asks the compositor to render
 * one toplevel into a shared-memory buffer, which also works for a window that
 * is on a hidden workspace or covered by another window.  It writes tightly
 * packed RGBA rows next to a JSON metadata line on stdout; PNG encoding stays
 * in the TypeScript layer so the helper needs nothing but wayland-client.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>
#include "ext-foreign-toplevel-list-v1-protocol.h"
#include "ext-image-capture-source-v1-protocol.h"
#include "ext-image-copy-capture-v1-protocol.h"

/* Largest image the helper accepts: 64 Mi pixels, about 8192x8192. */
#define MAX_PIXELS (64u * 1024u * 1024u)
/* Default overall deadline for one helper invocation. */
#define DEFAULT_TIMEOUT_MS 10000
/* How long to wait for the toplevel list's finished event. */
#define LIST_TIMEOUT_MS 3000

/* One foreign toplevel as announced by the compositor. */
struct toplevel {
	struct wl_list link;
	struct ext_foreign_toplevel_handle_v1 *handle;
	char *identifier;
	char *app_id;
	char *title;
	bool done;
	bool closed;
};

/* Helper state shared by the protocol listeners. */
struct state {
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_shm *shm;
	struct ext_foreign_toplevel_list_v1 *toplevel_list;
	struct ext_foreign_toplevel_image_capture_source_manager_v1 *source_manager;
	struct ext_image_copy_capture_manager_v1 *capture_manager;

	struct wl_list toplevels;
	bool list_finished;
	bool list_stopped;

	bool session_done;
	bool session_stopped;
	uint32_t width;
	uint32_t height;
	uint32_t shm_format;
	bool have_format;

	uint32_t transform;
	bool frame_ready;
	bool frame_failed;
	uint32_t frame_failure;

	/* What the helper is waiting for, quoted in a timeout message. */
	const char *stage;

	bool failed;
	char error[512];
};

/* Monotonic milliseconds. */
static int64_t now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* Record the first failure; later failures leave the reason alone. */
static void fail(struct state *s, const char *code, const char *detail) {
	if (s->failed)
		return;
	s->failed = true;
	snprintf(s->error, sizeof(s->error), "%s: %s", code, detail);
}

/* Record a failure with an errno description. */
static void fail_errno(struct state *s, const char *code) {
	char detail[256];
	snprintf(detail, sizeof(detail), "%s", strerror(errno));
	fail(s, code, detail);
}

/* Emit one JSON string, escaping what JSON requires. */
static void json_string(FILE *out, const char *value) {
	const unsigned char *p = (const unsigned char *)value;
	fputc('"', out);
	for (; *p != '\0'; p++) {
		switch (*p) {
		case '"': fputs("\\\"", out); break;
		case '\\': fputs("\\\\", out); break;
		case '\n': fputs("\\n", out); break;
		case '\r': fputs("\\r", out); break;
		case '\t': fputs("\\t", out); break;
		default:
			if (*p < 0x20)
				fprintf(out, "\\u%04x", (unsigned)*p);
			else
				fputc(*p, out);
		}
	}
	fputc('"', out);
}

/* Print the failure envelope and exit. */
static int report_failure(const struct state *s, const char *fallback) {
	printf("{\"ok\":false,\"code\":\"failed\",\"error\":");
	json_string(stdout, s->failed ? s->error : fallback);
	printf("}\n");
	fflush(stdout);
	return 1;
}

/* Pump the display until a flag is set or the deadline expires. */
static int pump_until(struct state *s, const bool *flag, int timeout_ms) {
	int64_t deadline = now_ms() + timeout_ms;
	for (;;) {
		if (*flag || s->failed)
			return s->failed ? -1 : 0;
		int64_t remaining = deadline - now_ms();
		if (remaining <= 0) {
			fail(s, "timeout", "the compositor did not answer in time");
			return -1;
		}
		struct pollfd pfd = {.fd = wl_display_get_fd(s->display), .events = POLLIN};
		if (wl_display_flush(s->display) < 0 && errno != EAGAIN) {
			fail_errno(s, "flush");
			return -1;
		}
		int rc = poll(&pfd, 1, (int)remaining);
		if (rc < 0) {
			if (errno == EINTR)
				continue;
			fail_errno(s, "poll");
			return -1;
		}
		if (rc == 0)
			continue;
		if (wl_display_dispatch(s->display) < 0) {
			fail(s, "protocol", strerror(errno));
			return -1;
		}
	}
}

/* Milliseconds left before a deadline, never negative. */
static int remaining_ms(int64_t deadline) {
	int64_t remaining = deadline - now_ms();
	return remaining > 0 ? (int)remaining : 0;
}

/**
 * Pump the display while waiting for a capture event.
 *
 * Returns 0 when the flag is set, 1 when the session stopped or the frame
 * failed (the caller inspects the terminal flag and may retry), and -1 on a
 * hard failure or timeout.
 */
static int pump_capture(struct state *s, const bool *flag, int timeout_ms) {
	int64_t deadline = now_ms() + timeout_ms;
	for (;;) {
		if (*flag)
			return 0;
		if (s->failed)
			return -1;
		if (s->session_stopped)
			return 1;
		if (s->frame_failed)
			return 1;
		int64_t remaining = deadline - now_ms();
		if (remaining <= 0) {
			fail(s, "timeout", s->stage != NULL ? s->stage : "the compositor did not answer in time");
			return -1;
		}
		struct pollfd pfd = {.fd = wl_display_get_fd(s->display), .events = POLLIN};
		if (wl_display_flush(s->display) < 0 && errno != EAGAIN) {
			fail_errno(s, "flush");
			return -1;
		}
		int rc = poll(&pfd, 1, (int)remaining);
		if (rc < 0) {
			if (errno == EINTR)
				continue;
			fail_errno(s, "poll");
			return -1;
		}
		if (rc == 0)
			continue;
		if (wl_display_dispatch(s->display) < 0) {
			fail(s, "protocol", strerror(errno));
			return -1;
		}
	}
}

/* Run one blocking roundtrip. */
static int roundtrip(struct state *s, const char *what) {
	if (wl_display_roundtrip(s->display) < 0) {
		fail(s, "protocol", what);
		return -1;
	}
	return 0;
}

/* Free one toplevel record. */
static void toplevel_destroy(struct toplevel *tl) {
	ext_foreign_toplevel_handle_v1_destroy(tl->handle);
	free(tl->identifier);
	free(tl->app_id);
	free(tl->title);
	free(tl);
}

static void handle_closed(void *data, struct ext_foreign_toplevel_handle_v1 *handle) {
	struct toplevel *tl = data;
	(void)handle;
	tl->closed = true;
}

static void handle_done(void *data, struct ext_foreign_toplevel_handle_v1 *handle) {
	struct toplevel *tl = data;
	(void)handle;
	tl->done = true;
}

static void handle_title(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *title) {
	struct toplevel *tl = data;
	(void)handle;
	free(tl->title);
	tl->title = strdup(title);
}

static void handle_app_id(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *app_id) {
	struct toplevel *tl = data;
	(void)handle;
	free(tl->app_id);
	tl->app_id = strdup(app_id);
}

static void handle_identifier(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *identifier) {
	struct toplevel *tl = data;
	(void)handle;
	free(tl->identifier);
	tl->identifier = strdup(identifier);
}

static const struct ext_foreign_toplevel_handle_v1_listener handle_listener = {
	.closed = handle_closed,
	.done = handle_done,
	.title = handle_title,
	.app_id = handle_app_id,
	.identifier = handle_identifier,
};

static void list_toplevel(void *data, struct ext_foreign_toplevel_list_v1 *list,
			  struct ext_foreign_toplevel_handle_v1 *handle) {
	struct state *s = data;
	(void)list;
	struct toplevel *tl = calloc(1, sizeof(*tl));
	if (tl == NULL) {
		fail(s, "memory", "out of memory");
		return;
	}
	tl->handle = handle;
	wl_list_insert(s->toplevels.prev, &tl->link);
	ext_foreign_toplevel_handle_v1_add_listener(handle, &handle_listener, tl);
}

static void list_finished(void *data, struct ext_foreign_toplevel_list_v1 *list) {
	struct state *s = data;
	(void)list;
	s->list_finished = true;
}

static const struct ext_foreign_toplevel_list_v1_listener list_listener = {
	.toplevel = list_toplevel,
	.finished = list_finished,
};

static void session_buffer_size(void *data, struct ext_image_copy_capture_session_v1 *session,
				uint32_t width, uint32_t height) {
	struct state *s = data;
	(void)session;
	s->width = width;
	s->height = height;
}

static void session_shm_format(void *data, struct ext_image_copy_capture_session_v1 *session,
			       uint32_t format) {
	struct state *s = data;
	(void)session;
	/* ARGB8888 is the preferred 32-bit format; XRGB8888 is an acceptable fallback. */
	if (!s->have_format && (format == WL_SHM_FORMAT_ARGB8888 || format == WL_SHM_FORMAT_XRGB8888)) {
		s->shm_format = format;
		s->have_format = true;
	} else if (format == WL_SHM_FORMAT_ARGB8888) {
		s->shm_format = format;
		s->have_format = true;
	}
}

static void session_dmabuf_device(void *data, struct ext_image_copy_capture_session_v1 *session,
				 struct wl_array *device) {
	(void)data;
	(void)session;
	(void)device;
}

static void session_dmabuf_format(void *data, struct ext_image_copy_capture_session_v1 *session,
				  uint32_t format, struct wl_array *modifiers) {
	(void)data;
	(void)session;
	(void)format;
	(void)modifiers;
}

static void session_done(void *data, struct ext_image_copy_capture_session_v1 *session) {
	struct state *s = data;
	(void)session;
	s->session_done = true;
}

static void session_stopped(void *data, struct ext_image_copy_capture_session_v1 *session) {
	struct state *s = data;
	(void)session;
	s->session_stopped = true;
}

static const struct ext_image_copy_capture_session_v1_listener session_listener = {
	.buffer_size = session_buffer_size,
	.shm_format = session_shm_format,
	.dmabuf_device = session_dmabuf_device,
	.dmabuf_format = session_dmabuf_format,
	.done = session_done,
	.stopped = session_stopped,
};

static void frame_transform(void *data, struct ext_image_copy_capture_frame_v1 *frame, uint32_t transform) {
	struct state *s = data;
	(void)frame;
	s->transform = transform;
}

static void frame_damage(void *data, struct ext_image_copy_capture_frame_v1 *frame,
			 int32_t x, int32_t y, int32_t width, int32_t height) {
	(void)data;
	(void)frame;
	(void)x;
	(void)y;
	(void)width;
	(void)height;
}

static void frame_presentation_time(void *data, struct ext_image_copy_capture_frame_v1 *frame,
				    uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec) {
	(void)data;
	(void)frame;
	(void)tv_sec_hi;
	(void)tv_sec_lo;
	(void)tv_nsec;
}

static void frame_ready(void *data, struct ext_image_copy_capture_frame_v1 *frame) {
	struct state *s = data;
	(void)frame;
	s->frame_ready = true;
}

static void frame_failed(void *data, struct ext_image_copy_capture_frame_v1 *frame, uint32_t reason) {
	struct state *s = data;
	(void)frame;
	s->frame_failed = true;
	s->frame_failure = reason;
}

static const struct ext_image_copy_capture_frame_v1_listener frame_listener = {
	.transform = frame_transform,
	.damage = frame_damage,
	.presentation_time = frame_presentation_time,
	.ready = frame_ready,
	.failed = frame_failed,
};

/* Bind the globals this helper needs. */
static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
			    const char *interface, uint32_t version) {
	struct state *s = data;
	if (strcmp(interface, wl_shm_interface.name) == 0)
		s->shm = wl_registry_bind(registry, name, &wl_shm_interface, version < 1 ? version : 1);
	else if (strcmp(interface, ext_foreign_toplevel_list_v1_interface.name) == 0)
		s->toplevel_list = wl_registry_bind(registry, name, &ext_foreign_toplevel_list_v1_interface, 1);
	else if (strcmp(interface, ext_foreign_toplevel_image_capture_source_manager_v1_interface.name) == 0)
		s->source_manager = wl_registry_bind(registry, name,
						     &ext_foreign_toplevel_image_capture_source_manager_v1_interface, 1);
	else if (strcmp(interface, ext_image_copy_capture_manager_v1_interface.name) == 0)
		s->capture_manager = wl_registry_bind(registry, name, &ext_image_copy_capture_manager_v1_interface, 1);
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
	(void)data;
	(void)registry;
	(void)name;
}

static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

/* Connect and read the registry. */
static int connect_state(struct state *s) {
	wl_list_init(&s->toplevels);
	s->display = wl_display_connect(NULL);
	if (s->display == NULL) {
		fail(s, "connect", "could not connect to the Wayland display");
		return -1;
	}
	s->registry = wl_display_get_registry(s->display);
	if (s->registry == NULL) {
		fail(s, "connect", "could not get the registry");
		return -1;
	}
	wl_registry_add_listener(s->registry, &registry_listener, s);
	return roundtrip(s, "reading the registry");
}

/* Subscribe to the foreign-toplevel list and wait for its first batch. */
static int read_toplevel_list(struct state *s, int timeout_ms) {
	if (s->toplevel_list == NULL) {
		fail(s, "unsupported", "the compositor does not advertise ext_foreign_toplevel_list_v1");
		return -1;
	}
	ext_foreign_toplevel_list_v1_add_listener(s->toplevel_list, &list_listener, s);
	/* Hyprland only sends `finished` in reply to `stop`, and stop is also the
	 * portable way to ask for the initial batch to be complete. */
	ext_foreign_toplevel_list_v1_stop(s->toplevel_list);
	if (pump_until(s, &s->list_finished, timeout_ms) < 0)
		return -1;
	return 0;
}

/* Find one toplevel by identifier; case-insensitive so a caller may pass either case. */
static struct toplevel *find_toplevel(struct state *s, const char *identifier) {
	struct toplevel *tl;
	wl_list_for_each(tl, &s->toplevels, link) {
		if (tl->closed || tl->identifier == NULL)
			continue;
		if (strcmp(tl->identifier, identifier) == 0)
			return tl;
	}
	wl_list_for_each(tl, &s->toplevels, link) {
		if (tl->closed || tl->identifier == NULL)
			continue;
		if (strcasecmp(tl->identifier, identifier) == 0)
			return tl;
	}
	return NULL;
}

/* Create the source and the session for one toplevel, and wait for its constraints. */
static int begin_session(struct state *s, struct toplevel *tl, int timeout_ms,
			 struct ext_image_copy_capture_session_v1 **out_session) {
	if (s->source_manager == NULL || s->capture_manager == NULL) {
		fail(s, "unsupported", "the compositor does not advertise ext-image-copy-capture for foreign toplevels");
		return -1;
	}
	struct ext_image_capture_source_v1 *source =
		ext_foreign_toplevel_image_capture_source_manager_v1_create_source(s->source_manager, tl->handle);
	if (source == NULL) {
		fail(s, "source", "the compositor rejected the toplevel capture source");
		return -1;
	}
	struct ext_image_copy_capture_session_v1 *session =
		ext_image_copy_capture_manager_v1_create_session(s->capture_manager, source, 0);
	ext_image_capture_source_v1_destroy(source);
	if (session == NULL) {
		fail(s, "session", "the compositor rejected the capture session");
		return -1;
	}
	ext_image_copy_capture_session_v1_add_listener(session, &session_listener, s);
	s->stage = "waiting for the capture session's buffer constraints";
	if (pump_capture(s, &s->session_done, timeout_ms) != 0) {
		if (!s->failed)
			fail(s, "stopped", "the compositor stopped the capture session before it started");
		ext_image_copy_capture_session_v1_destroy(session);
		return -1;
	}
	*out_session = session;
	return 0;
}

/* Validate the buffer constraints the compositor reported. */
static int validate_constraints(struct state *s) {
	if (s->width == 0 || s->height == 0) {
		fail(s, "size", "the compositor reported an empty capture size");
		return -1;
	}
	if (!s->have_format) {
		fail(s, "format", "the compositor advertised no 32-bit shared-memory capture format");
		return -1;
	}
	if ((uint64_t)s->width * (uint64_t)s->height > MAX_PIXELS) {
		fail(s, "too-large", "the toplevel is larger than the capture limit");
		return -1;
	}
	return 0;
}

/* Copy one captured frame into a tightly packed RGBA file. */
static int write_rgba(const struct state *s, const uint8_t *data, size_t stride,
		      const char *path, uint32_t *out_bytes) {
	size_t size = (size_t)s->width * (size_t)s->height * 4u;
	uint8_t *rgba = malloc(size == 0 ? 1 : size);
	if (rgba == NULL)
		return -1;
	for (uint32_t y = 0; y < s->height; y++) {
		const uint8_t *row = data + (size_t)y * stride;
		uint8_t *out = rgba + (size_t)y * (size_t)s->width * 4u;
		for (uint32_t x = 0; x < s->width; x++) {
			const uint8_t *px = row + (size_t)x * 4u;
			out[0] = px[2];
			out[1] = px[1];
			out[2] = px[0];
			out[3] = 0xff;
			out += 4;
		}
	}
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd < 0) {
		free(rgba);
		return -1;
	}
	size_t written = 0;
	int result = 0;
	while (written < size) {
		ssize_t chunk = write(fd, rgba + written, size - written);
		if (chunk < 0) {
			if (errno == EINTR)
				continue;
			result = -1;
			break;
		}
		written += (size_t)chunk;
	}
	close(fd);
	free(rgba);
	*out_bytes = (uint32_t)size;
	return result;
}

/* Capture the toplevel's current contents.
 *
 * A window can be resized while the capture session is being set up, and the
 * compositor then rejects the frame because the buffer constraints no longer
 * match.  The helper waits for the updated constraints and retries with a
 * fresh buffer instead of reporting that race as a failed capture.
 */
static int capture_toplevel(struct state *s, struct toplevel *tl, const char *raw_path, int timeout_ms) {
	int64_t deadline = now_ms() + timeout_ms;
	struct ext_image_copy_capture_session_v1 *session = NULL;
	struct ext_image_copy_capture_frame_v1 *frame = NULL;
	struct wl_buffer *buffer = NULL;
	int fd = -1;
	void *mapped = MAP_FAILED;
	size_t mapped_size = 0;
	size_t buffer_size = 0;
	uint32_t bytes = 0;
	int attempts = 0;

	if (begin_session(s, tl, remaining_ms(deadline), &session) < 0)
		return -1;
	for (;;) {
		if (attempts >= 3) {
			fail(s, "frame-failed", "the window kept changing size while it was captured");
			goto done;
		}
		attempts++;
		if (validate_constraints(s) < 0)
			goto done;
		uint32_t stride = s->width * 4u;
		buffer_size = (size_t)stride * (size_t)s->height;
		if (buffer != NULL) {
			wl_buffer_destroy(buffer);
			buffer = NULL;
		}
		if (mapped != MAP_FAILED) {
			munmap(mapped, mapped_size);
			mapped = MAP_FAILED;
			mapped_size = 0;
		}
		if (fd >= 0) {
			close(fd);
			fd = -1;
		}
		fd = memfd_create("wl-capture", MFD_CLOEXEC);
		if (fd < 0) {
			fail_errno(s, "memfd");
			goto done;
		}
		if (ftruncate(fd, (off_t)buffer_size) < 0) {
			fail_errno(s, "ftruncate");
			goto done;
		}
		mapped = mmap(NULL, buffer_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
		if (mapped == MAP_FAILED) {
			fail_errno(s, "mmap");
			goto done;
		}
		mapped_size = buffer_size;
		struct wl_shm_pool *pool = wl_shm_create_pool(s->shm, fd, (int32_t)buffer_size);
		if (pool == NULL) {
			fail(s, "shm", "the compositor refused the shared-memory pool");
			goto done;
		}
		buffer = wl_shm_pool_create_buffer(pool, 0, (int32_t)s->width, (int32_t)s->height, (int32_t)stride,
						   (uint32_t)s->shm_format);
		wl_shm_pool_destroy(pool);
		if (buffer == NULL) {
			fail(s, "shm", "the compositor refused the shared-memory buffer");
			goto done;
		}
		if (frame == NULL) {
			frame = ext_image_copy_capture_session_v1_create_frame(session);
			if (frame == NULL) {
				fail(s, "frame", "the compositor rejected the capture frame");
				goto done;
			}
			ext_image_copy_capture_frame_v1_add_listener(frame, &frame_listener, s);
		}
		s->frame_ready = false;
		s->frame_failed = false;
		s->stage = "waiting for the captured frame";
		ext_image_copy_capture_frame_v1_attach_buffer(frame, buffer);
		ext_image_copy_capture_frame_v1_damage_buffer(frame, 0, 0, (int32_t)s->width, (int32_t)s->height);
		ext_image_copy_capture_frame_v1_capture(frame);
		int waited = pump_capture(s, &s->frame_ready, remaining_ms(deadline));
		if (waited < 0)
			goto done;
		if (s->frame_failed) {
			uint32_t reason = s->frame_failure;
			if (reason == 1 && attempts < 3) {
				ext_image_copy_capture_frame_v1_destroy(frame);
				frame = NULL;
				s->frame_failed = false;
				s->session_done = false;
				s->stage = "waiting for updated buffer constraints";
				int constrained = pump_capture(s, &s->session_done, remaining_ms(deadline));
				if (constrained < 0)
					goto done;
				if (constrained != 0) {
					fail(s, "stopped", "the compositor stopped the capture session");
					goto done;
				}
				continue;
			}
			fail(s, "frame-failed", reason == 1 ? "buffer constraints"
				: reason == 2 ? "source stopped" : "unknown");
			goto done;
		}
		if (waited != 0 || !s->frame_ready) {
			fail(s, "stopped", "the compositor stopped the capture session");
			goto done;
		}
		if (write_rgba(s, mapped, stride, raw_path, &bytes) < 0) {
			fail_errno(s, "write");
			goto done;
		}
		printf("{\"ok\":true,\"identifier\":");
		json_string(stdout, tl->identifier != NULL ? tl->identifier : "");
		printf(",\"appId\":");
		json_string(stdout, tl->app_id != NULL ? tl->app_id : "");
		printf(",\"title\":");
		json_string(stdout, tl->title != NULL ? tl->title : "");
		printf(",\"width\":%" PRIu32 ",\"height\":%" PRIu32 ",\"format\":\"%s\",\"transform\":%" PRIu32
		       ",\"bytes\":%" PRIu32 "}\n",
		       s->width, s->height, s->shm_format == WL_SHM_FORMAT_ARGB8888 ? "argb8888" : "xrgb8888",
		       s->transform, bytes);
		fflush(stdout);
		goto done;
	}

done:
	if (mapped != MAP_FAILED)
		munmap(mapped, mapped_size);
	if (fd >= 0)
		close(fd);
	if (buffer != NULL)
		wl_buffer_destroy(buffer);
	if (frame != NULL)
		ext_image_copy_capture_frame_v1_destroy(frame);
	if (session != NULL)
		ext_image_copy_capture_session_v1_destroy(session);
	return s->failed ? -1 : 0;
}

/* Print the toplevel list as JSON. */
static void print_list(struct state *s) {
	struct toplevel *tl;
	printf("{\"ok\":true,\"toplevels\":[");
	bool first = true;
	wl_list_for_each(tl, &s->toplevels, link) {
		if (tl->closed || tl->identifier == NULL)
			continue;
		if (!first)
			fputc(',', stdout);
		first = false;
		printf("{\"identifier\":");
		json_string(stdout, tl->identifier);
		printf(",\"appId\":");
		json_string(stdout, tl->app_id != NULL ? tl->app_id : "");
		printf(",\"title\":");
		json_string(stdout, tl->title != NULL ? tl->title : "");
		printf("}");
	}
	printf("]}\n");
	fflush(stdout);
}

/* Release every protocol object and the list. */
static void teardown(struct state *s) {
	struct toplevel *tl;
	struct toplevel *next;
	wl_list_for_each_safe(tl, next, &s->toplevels, link) {
		wl_list_remove(&tl->link);
		toplevel_destroy(tl);
	}
	if (s->toplevel_list != NULL)
		ext_foreign_toplevel_list_v1_destroy(s->toplevel_list);
	if (s->source_manager != NULL)
		ext_foreign_toplevel_image_capture_source_manager_v1_destroy(s->source_manager);
	if (s->capture_manager != NULL)
		ext_image_copy_capture_manager_v1_destroy(s->capture_manager);
	if (s->shm != NULL)
		wl_shm_destroy(s->shm);
	if (s->registry != NULL)
		wl_registry_destroy(s->registry);
	if (s->display != NULL)
		wl_display_disconnect(s->display);
}

static void usage(void) {
	fprintf(stderr,
		"usage: wl-capture --list\n"
		"       wl-capture --capture <identifier> --raw <path> [--timeout-ms N]\n");
}

int main(int argc, char **argv) {
	struct state s;
	memset(&s, 0, sizeof(s));
	bool list_mode = false;
	const char *capture_id = NULL;
	const char *raw_path = NULL;
	int timeout_ms = DEFAULT_TIMEOUT_MS;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--list") == 0) {
			list_mode = true;
		} else if (strcmp(argv[i], "--capture") == 0 && i + 1 < argc) {
			capture_id = argv[++i];
		} else if (strcmp(argv[i], "--raw") == 0 && i + 1 < argc) {
			raw_path = argv[++i];
		} else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) {
			timeout_ms = atoi(argv[++i]);
		} else {
			usage();
			return 2;
		}
	}
	if (list_mode && capture_id != NULL) {
		usage();
		return 2;
	}
	if (!list_mode && capture_id == NULL) {
		usage();
		return 2;
	}
	if (!list_mode && raw_path == NULL) {
		usage();
		return 2;
	}
	if (timeout_ms <= 0)
		timeout_ms = DEFAULT_TIMEOUT_MS;

	if (connect_state(&s) < 0) {
		int code = report_failure(&s, "could not connect");
		teardown(&s);
		return code;
	}
	if (read_toplevel_list(&s, LIST_TIMEOUT_MS) < 0) {
		int code = report_failure(&s, "could not read the toplevel list");
		teardown(&s);
		return code;
	}
	int result = 0;
	if (list_mode) {
		print_list(&s);
	} else {
		struct toplevel *tl = find_toplevel(&s, capture_id);
		if (tl == NULL) {
			fail(&s, "toplevel-not-found", "no mapped toplevel has this identifier");
			result = report_failure(&s, "toplevel not found");
		} else if (capture_toplevel(&s, tl, raw_path, timeout_ms) < 0) {
			result = report_failure(&s, "capture failed");
		}
	}
	teardown(&s);
	return result;
}

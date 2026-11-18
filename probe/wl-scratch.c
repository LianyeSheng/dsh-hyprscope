/**
 * Minimal xdg-shell scratch client for the capability probe.
 *
 * It is a plain Wayland client (wl_compositor + xdg_wm_base + wl_shm + wl_seat)
 * that opens exactly one 320x200 toplevel titled and classed
 * "hyprscope-scratch". The behavioral probe targets this window and nothing
 * else. SIGUSR1 lifts the fixed 320x200 hints so the probe can measure a real
 * resize round trip. Events are printed as one JSON line each on stdout and
 * flushed immediately; stderr carries diagnostics only. SIGTERM, SIGINT, or an
 * xdg_toplevel close request end the process cleanly.
 */
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>

#include "xdg-shell-client-protocol.h"

#define SCRATCH_WIDTH 320
#define SCRATCH_HEIGHT 200
#define SCRATCH_STRIDE (SCRATCH_WIDTH * 4)
#define SCRATCH_APP_ID "hyprscope-scratch"
#define SCRATCH_TITLE "hyprscope-scratch"

struct client {
  struct wl_display *display;
  struct wl_registry *registry;
  struct wl_compositor *compositor;
  struct xdg_wm_base *wm_base;
  struct wl_shm *shm;
  struct wl_seat *seat;
  struct wl_keyboard *keyboard;
  struct wl_surface *surface;
  struct xdg_surface *xdg_surface;
  struct xdg_toplevel *toplevel;
  struct wl_buffer *buffer;
  void *pixels;
  size_t pixels_size;
  int shm_fd;
  int configured;
  int mapped;
  int closed;
  int failed;
};

static volatile sig_atomic_t stop_requested = 0;
/* SIGUSR1 lifts the fixed 320x200 hints so the probe can measure a resize. */
static volatile sig_atomic_t release_constraints = 0;
static int signal_pipe[2] = {-1, -1};

/* ------------------------------------------------------------------ */
/* output                                                             */
/* ------------------------------------------------------------------ */

static void print_ready(void) {
  printf("{\"event\":\"ready\",\"width\":%d,\"height\":%d}\n", SCRATCH_WIDTH,
         SCRATCH_HEIGHT);
  fflush(stdout);
}

static void print_close(void) {
  printf("{\"event\":\"close\"}\n");
  fflush(stdout);
}

/* ------------------------------------------------------------------ */
/* signals                                                            */
/* ------------------------------------------------------------------ */

static void on_signal(int signum) {
  (void)signum;
  stop_requested = 1;
  if (signal_pipe[1] >= 0) {
    ssize_t ignored = write(signal_pipe[1], "x", 1);
    (void)ignored;
  }
}

static void on_release_constraints(int signum) {
  (void)signum;
  release_constraints = 1;
}

static int setup_signals(void) {
  if (pipe2(signal_pipe, O_CLOEXEC | O_NONBLOCK) < 0) {
    fprintf(stderr, "wl-scratch: pipe2 failed: %s\n", strerror(errno));
    return -1;
  }
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = on_signal;
  sigemptyset(&action.sa_mask);
  action.sa_flags = 0;
  if (sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0) {
    fprintf(stderr, "wl-scratch: sigaction failed: %s\n", strerror(errno));
    return -1;
  }
  action.sa_handler = on_release_constraints;
  if (sigaction(SIGUSR1, &action, NULL) < 0) {
    fprintf(stderr, "wl-scratch: sigaction(SIGUSR1) failed: %s\n", strerror(errno));
    return -1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* buffer                                                             */
/* ------------------------------------------------------------------ */

static int create_buffer(struct client *c) {
  int fd = memfd_create("hyprscope-scratch", MFD_CLOEXEC);
  if (fd < 0) {
    fprintf(stderr, "wl-scratch: memfd_create failed: %s\n", strerror(errno));
    return -1;
  }
  size_t size = (size_t)SCRATCH_STRIDE * SCRATCH_HEIGHT;
  if (ftruncate(fd, (off_t)size) < 0) {
    fprintf(stderr, "wl-scratch: ftruncate failed: %s\n", strerror(errno));
    close(fd);
    return -1;
  }
  void *pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED) {
    fprintf(stderr, "wl-scratch: mmap failed: %s\n", strerror(errno));
    close(fd);
    return -1;
  }
  uint32_t *words = pixels;
  size_t count = size / sizeof(uint32_t);
  for (size_t i = 0; i < count; i++) words[i] = 0xFF202020u;

  struct wl_shm_pool *pool = wl_shm_create_pool(c->shm, fd, (int32_t)size);
  if (pool == NULL) {
    fprintf(stderr, "wl-scratch: wl_shm_create_pool failed\n");
    munmap(pixels, size);
    close(fd);
    return -1;
  }
  c->buffer = wl_shm_pool_create_buffer(pool, 0, SCRATCH_WIDTH, SCRATCH_HEIGHT,
                                        SCRATCH_STRIDE, WL_SHM_FORMAT_ARGB8888);
  wl_shm_pool_destroy(pool);
  if (c->buffer == NULL) {
    fprintf(stderr, "wl-scratch: wl_shm_pool_create_buffer failed\n");
    munmap(pixels, size);
    close(fd);
    return -1;
  }
  c->pixels = pixels;
  c->pixels_size = size;
  c->shm_fd = fd;
  return 0;
}

static void draw(struct client *c) {
  struct wl_region *region = wl_compositor_create_region(c->compositor);
  if (region != NULL) {
    wl_region_add(region, 0, 0, SCRATCH_WIDTH, SCRATCH_HEIGHT);
    wl_surface_set_opaque_region(c->surface, region);
    wl_region_destroy(region);
  }
  wl_surface_attach(c->surface, c->buffer, 0, 0);
  wl_surface_damage_buffer(c->surface, 0, 0, SCRATCH_WIDTH, SCRATCH_HEIGHT);
  wl_surface_commit(c->surface);
}

/* ------------------------------------------------------------------ */
/* xdg-shell                                                          */
/* ------------------------------------------------------------------ */

static void on_wm_base_ping(void *data, struct xdg_wm_base *wm_base, uint32_t serial) {
  (void)data;
  xdg_wm_base_pong(wm_base, serial);
}

static const struct xdg_wm_base_listener WM_BASE_LISTENER = {
    .ping = on_wm_base_ping,
};

static void on_surface_configure(void *data, struct xdg_surface *surface, uint32_t serial) {
  struct client *c = data;
  xdg_surface_ack_configure(surface, serial);
  c->configured = 1;
  if (!c->mapped) {
    if (c->buffer == NULL && create_buffer(c) != 0) {
      c->failed = 1;
      return;
    }
    draw(c);
    c->mapped = 1;
    print_ready();
    if (wl_display_flush(c->display) < 0 && errno != EAGAIN) {
      c->failed = 1;
    }
  }
}

static const struct xdg_surface_listener SURFACE_LISTENER = {
    .configure = on_surface_configure,
};

static void on_toplevel_configure(void *data, struct xdg_toplevel *toplevel,
                                  int32_t width, int32_t height,
                                  struct wl_array *states) {
  (void)data;
  (void)toplevel;
  (void)width;
  (void)height;
  (void)states;
}

static void on_toplevel_close(void *data, struct xdg_toplevel *toplevel) {
  (void)toplevel;
  struct client *c = data;
  print_close();
  c->closed = 1;
}

static void on_toplevel_configure_bounds(void *data, struct xdg_toplevel *toplevel,
                                         int32_t width, int32_t height) {
  (void)data;
  (void)toplevel;
  (void)width;
  (void)height;
}

static void on_toplevel_wm_capabilities(void *data, struct xdg_toplevel *toplevel,
                                        struct wl_array *capabilities) {
  (void)data;
  (void)toplevel;
  (void)capabilities;
}

static const struct xdg_toplevel_listener TOPLEVEL_LISTENER = {
    .configure = on_toplevel_configure,
    .close = on_toplevel_close,
    .configure_bounds = on_toplevel_configure_bounds,
    .wm_capabilities = on_toplevel_wm_capabilities,
};

/* ------------------------------------------------------------------ */
/* keyboard                                                           */
/* ------------------------------------------------------------------ */

static void on_keyboard_keymap(void *data, struct wl_keyboard *keyboard,
                               uint32_t format, int32_t fd, uint32_t size) {
  (void)data;
  (void)keyboard;
  (void)format;
  (void)size;
  close(fd);
}

static void on_keyboard_enter(void *data, struct wl_keyboard *keyboard,
                              uint32_t serial, struct wl_surface *surface,
                              struct wl_array *keys) {
  (void)data;
  (void)keyboard;
  (void)serial;
  (void)surface;
  (void)keys;
}

static void on_keyboard_leave(void *data, struct wl_keyboard *keyboard,
                              uint32_t serial, struct wl_surface *surface) {
  (void)data;
  (void)keyboard;
  (void)serial;
  (void)surface;
}

static void on_keyboard_key(void *data, struct wl_keyboard *keyboard,
                            uint32_t serial, uint32_t time, uint32_t key,
                            uint32_t state) {
  (void)data;
  (void)keyboard;
  (void)serial;
  (void)time;
  const char *state_name = NULL;
  if (state == WL_KEYBOARD_KEY_STATE_PRESSED) {
    state_name = "pressed";
  } else if (state == WL_KEYBOARD_KEY_STATE_RELEASED) {
    state_name = "released";
  }
  if (state_name == NULL) return;
  printf("{\"event\":\"key\",\"code\":%u,\"state\":\"%s\"}\n", key, state_name);
  fflush(stdout);
}

static void on_keyboard_modifiers(void *data, struct wl_keyboard *keyboard,
                                  uint32_t serial, uint32_t depressed,
                                  uint32_t latched, uint32_t locked,
                                  uint32_t group) {
  (void)data;
  (void)keyboard;
  (void)serial;
  (void)depressed;
  (void)latched;
  (void)locked;
  (void)group;
}

static void on_keyboard_repeat_info(void *data, struct wl_keyboard *keyboard,
                                    int32_t rate, int32_t delay) {
  (void)data;
  (void)keyboard;
  (void)rate;
  (void)delay;
}

static const struct wl_keyboard_listener KEYBOARD_LISTENER = {
    .keymap = on_keyboard_keymap,
    .enter = on_keyboard_enter,
    .leave = on_keyboard_leave,
    .key = on_keyboard_key,
    .modifiers = on_keyboard_modifiers,
    .repeat_info = on_keyboard_repeat_info,
};

/* ------------------------------------------------------------------ */
/* registry, seat, shm                                                */
/* ------------------------------------------------------------------ */

static const struct wl_seat_listener SEAT_LISTENER;
static const struct wl_shm_listener SHM_LISTENER;

static void on_global(void *data, struct wl_registry *registry, uint32_t name,
                      const char *interface, uint32_t version) {
  struct client *c = data;
  if (strcmp(interface, "wl_compositor") == 0) {
    if (c->compositor == NULL) {
      uint32_t bind_version = version < 4 ? version : 4;
      c->compositor = wl_registry_bind(registry, name, &wl_compositor_interface,
                                       bind_version);
    }
  } else if (strcmp(interface, "xdg_wm_base") == 0) {
    if (c->wm_base == NULL) {
      c->wm_base = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
      xdg_wm_base_add_listener(c->wm_base, &WM_BASE_LISTENER, c);
    }
  } else if (strcmp(interface, "wl_shm") == 0) {
    if (c->shm == NULL) {
      c->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
      wl_shm_add_listener(c->shm, &SHM_LISTENER, c);
    }
  } else if (strcmp(interface, "wl_seat") == 0) {
    if (c->seat == NULL) {
      uint32_t bind_version = version < 4 ? version : 4;
      c->seat = wl_registry_bind(registry, name, &wl_seat_interface, bind_version);
      wl_seat_add_listener(c->seat, &SEAT_LISTENER, c);
    }
  }
}

static void on_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener REGISTRY_LISTENER = {
    .global = on_global,
    .global_remove = on_global_remove,
};

static void on_seat_capabilities(void *data, struct wl_seat *seat, uint32_t capabilities) {
  struct client *c = data;
  if ((capabilities & WL_SEAT_CAPABILITY_KEYBOARD) != 0) {
    if (c->keyboard == NULL) {
      c->keyboard = wl_seat_get_keyboard(seat);
      if (c->keyboard != NULL) {
        wl_keyboard_add_listener(c->keyboard, &KEYBOARD_LISTENER, c);
      }
    }
  } else if (c->keyboard != NULL) {
    wl_keyboard_destroy(c->keyboard);
    c->keyboard = NULL;
  }
}

static void on_seat_name(void *data, struct wl_seat *seat, const char *name) {
  (void)data;
  (void)seat;
  (void)name;
}

static const struct wl_seat_listener SEAT_LISTENER = {
    .capabilities = on_seat_capabilities,
    .name = on_seat_name,
};

static void on_shm_format(void *data, struct wl_shm *shm, uint32_t format) {
  (void)data;
  (void)shm;
  (void)format;
}

static const struct wl_shm_listener SHM_LISTENER = {
    .format = on_shm_format,
};

/* ------------------------------------------------------------------ */
/* main loop                                                          */
/* ------------------------------------------------------------------ */

static const char *display_error(struct wl_display *display, char *buffer, size_t size) {
  int err = wl_display_get_error(display);
  if (err == EPIPE) return "the compositor disconnected";
  const struct wl_interface *iface = NULL;
  uint32_t id = 0;
  int code = wl_display_get_protocol_error(display, &iface, &id);
  if (iface != NULL) {
    snprintf(buffer, size, "protocol error %d on %s@%u", code, iface->name, id);
    return buffer;
  }
  if (err != 0) {
    snprintf(buffer, size, "display error: %s", strerror(err));
    return buffer;
  }
  return "the display reported an error";
}

static int run_loop(struct client *c) {
  struct pollfd fds[2];
  char buffer[512];
  while (stop_requested == 0 && c->closed == 0 && c->failed == 0) {
    if (release_constraints != 0) {
      release_constraints = 0;
      if (c->toplevel != NULL) {
        xdg_toplevel_set_min_size(c->toplevel, 0, 0);
        xdg_toplevel_set_max_size(c->toplevel, 0, 0);
        wl_surface_commit(c->surface);
        fprintf(stderr, "wl-scratch: released the fixed size hints\n");
      }
    }
    while (wl_display_prepare_read(c->display) != 0) {
      if (wl_display_dispatch_pending(c->display) < 0) {
        fprintf(stderr, "wl-scratch: dispatch failed: %s\n",
                display_error(c->display, buffer, sizeof buffer));
        return 1;
      }
      if (stop_requested != 0 || c->closed != 0 || c->failed != 0) return c->failed ? 1 : 0;
    }
    if (wl_display_flush(c->display) < 0 && errno != EAGAIN) {
      wl_display_cancel_read(c->display);
      fprintf(stderr, "wl-scratch: flush failed: %s\n",
              display_error(c->display, buffer, sizeof buffer));
      return 1;
    }
    fds[0].fd = wl_display_get_fd(c->display);
    fds[0].events = POLLIN;
    fds[0].revents = 0;
    fds[1].fd = signal_pipe[0];
    fds[1].events = POLLIN;
    fds[1].revents = 0;
    int ready = poll(fds, 2, -1);
    if (ready < 0) {
      wl_display_cancel_read(c->display);
      if (errno == EINTR) continue;
      fprintf(stderr, "wl-scratch: poll failed: %s\n", strerror(errno));
      return 1;
    }
    if ((fds[1].revents & POLLIN) != 0) {
      wl_display_cancel_read(c->display);
      break;
    }
    if ((fds[0].revents & POLLIN) != 0) {
      if (wl_display_read_events(c->display) < 0) {
        fprintf(stderr, "wl-scratch: read failed: %s\n",
                display_error(c->display, buffer, sizeof buffer));
        return 1;
      }
    } else {
      wl_display_cancel_read(c->display);
      if ((fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
        fprintf(stderr, "wl-scratch: the compositor connection ended\n");
        return 1;
      }
      continue;
    }
    if (wl_display_dispatch_pending(c->display) < 0) {
      fprintf(stderr, "wl-scratch: dispatch failed: %s\n",
              display_error(c->display, buffer, sizeof buffer));
      return 1;
    }
  }
  return c->failed ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* teardown and main                                                  */
/* ------------------------------------------------------------------ */

static void teardown(struct client *c) {
  if (c->display != NULL) {
    if (wl_display_get_error(c->display) == 0) {
      if (c->buffer != NULL) {
        wl_buffer_destroy(c->buffer);
        c->buffer = NULL;
      }
      if (c->toplevel != NULL) {
        xdg_toplevel_destroy(c->toplevel);
        c->toplevel = NULL;
      }
      if (c->xdg_surface != NULL) {
        xdg_surface_destroy(c->xdg_surface);
        c->xdg_surface = NULL;
      }
      if (c->surface != NULL) {
        wl_surface_destroy(c->surface);
        c->surface = NULL;
      }
      if (c->keyboard != NULL) {
        wl_keyboard_destroy(c->keyboard);
        c->keyboard = NULL;
      }
      if (c->seat != NULL) {
        wl_seat_destroy(c->seat);
        c->seat = NULL;
      }
      if (c->wm_base != NULL) {
        xdg_wm_base_destroy(c->wm_base);
        c->wm_base = NULL;
      }
      if (c->shm != NULL) {
        wl_shm_destroy(c->shm);
        c->shm = NULL;
      }
      if (c->compositor != NULL) {
        wl_compositor_destroy(c->compositor);
        c->compositor = NULL;
      }
      if (c->registry != NULL) {
        wl_registry_destroy(c->registry);
        c->registry = NULL;
      }
      wl_display_flush(c->display);
    }
    wl_display_disconnect(c->display);
    c->display = NULL;
  }
  if (c->pixels != NULL) {
    munmap(c->pixels, c->pixels_size);
    c->pixels = NULL;
  }
  if (c->shm_fd >= 0) {
    close(c->shm_fd);
    c->shm_fd = -1;
  }
  if (signal_pipe[0] >= 0) close(signal_pipe[0]);
  if (signal_pipe[1] >= 0) close(signal_pipe[1]);
  signal_pipe[0] = -1;
  signal_pipe[1] = -1;
}

int main(void) {
  struct client c;
  memset(&c, 0, sizeof c);
  c.shm_fd = -1;

  if (setup_signals() != 0) return 1;

  c.display = wl_display_connect(NULL);
  if (c.display == NULL) {
    fprintf(stderr, "wl-scratch: cannot connect to the Wayland display\n");
    teardown(&c);
    return 1;
  }
  c.registry = wl_display_get_registry(c.display);
  if (c.registry == NULL) {
    fprintf(stderr, "wl-scratch: cannot create the registry\n");
    teardown(&c);
    return 1;
  }
  wl_registry_add_listener(c.registry, &REGISTRY_LISTENER, &c);
  if (wl_display_roundtrip(c.display) < 0) {
    fprintf(stderr, "wl-scratch: registry roundtrip failed\n");
    teardown(&c);
    return 1;
  }
  if (c.compositor == NULL || c.wm_base == NULL || c.shm == NULL) {
    fprintf(stderr, "wl-scratch: missing wl_compositor, xdg_wm_base, or wl_shm\n");
    teardown(&c);
    return 1;
  }

  c.surface = wl_compositor_create_surface(c.compositor);
  if (c.surface == NULL) {
    fprintf(stderr, "wl-scratch: cannot create the surface\n");
    teardown(&c);
    return 1;
  }
  c.xdg_surface = xdg_wm_base_get_xdg_surface(c.wm_base, c.surface);
  if (c.xdg_surface == NULL) {
    fprintf(stderr, "wl-scratch: cannot create the xdg surface\n");
    teardown(&c);
    return 1;
  }
  xdg_surface_add_listener(c.xdg_surface, &SURFACE_LISTENER, &c);
  c.toplevel = xdg_surface_get_toplevel(c.xdg_surface);
  if (c.toplevel == NULL) {
    fprintf(stderr, "wl-scratch: cannot create the toplevel\n");
    teardown(&c);
    return 1;
  }
  xdg_toplevel_add_listener(c.toplevel, &TOPLEVEL_LISTENER, &c);
  xdg_toplevel_set_title(c.toplevel, SCRATCH_TITLE);
  xdg_toplevel_set_app_id(c.toplevel, SCRATCH_APP_ID);
  xdg_toplevel_set_min_size(c.toplevel, SCRATCH_WIDTH, SCRATCH_HEIGHT);
  xdg_toplevel_set_max_size(c.toplevel, SCRATCH_WIDTH, SCRATCH_HEIGHT);
  wl_surface_commit(c.surface);

  int status = run_loop(&c);
  teardown(&c);
  return status;
}
#ifndef WLI_WAYLAND_H
#define WLI_WAYLAND_H

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

/* Wayland connection, virtual input objects and event emitters. */
#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "generated/virtual-keyboard-unstable-v1-protocol.h"
#include "generated/wlr-virtual-pointer-unstable-v1-protocol.h"

#include "json.h"
#include "lease.h"

#define MAX_GLOBALS 256
#define KEYMAP_FORMAT_XKB_V1 1

/* xkbcommon modifier-mask bits for the fixed US keymap below (shift, control,
 * mod1/alt, mod4/super).  The virtual-keyboard protocol has a modifiers
 * request; Hyprland does not derive modifier state from key events for virtual
 * keyboards, so the helper must announce it explicitly for compositor binds. */
#define WLI_MOD_SHIFT 1u
#define WLI_MOD_CTRL 4u
#define WLI_MOD_ALT 8u
#define WLI_MOD_META 64u

/* Sent once at startup; the compositor compiles it with xkbcommon. */
static const char KEYMAP_TEXT[] =
    "xkb_keymap {\n"
    "  xkb_keycodes { include \"evdev+aliases(qwerty)\" };\n"
    "  xkb_types { include \"complete\" };\n"
    "  xkb_compat { include \"complete\" };\n"
    "  xkb_symbols { include \"pc+us+inet(evdev)\" };\n"
    "};\n";
/* ------------------------------------------------------------------ */
/* Wayland context and helpers                                        */
/* ------------------------------------------------------------------ */

struct global_info {
  char interface[64];
  uint32_t name;
  uint32_t version;
};

struct ctx {
  struct wl_display *display;
  struct wl_registry *registry;
  struct wl_seat *seat;
  struct zwlr_virtual_pointer_manager_v1 *vp_manager;
  struct zwp_virtual_keyboard_manager_v1 *vk_manager;
  struct zwlr_virtual_pointer_v1 *pointer;
  struct zwp_virtual_keyboard_v1 *keyboard;

  uint32_t seat_name;
  uint32_t vp_name, vp_version, vk_name, vk_version;
  int seat_count;
  struct global_info globals[MAX_GLOBALS];
  int n_globals;

  char display_name[128];
  uint32_t extent_w, extent_h;

  int probe;
  int dry_run;

  struct outbuf events; /* dry-run actions for the current command */
  int nevents;
  uint32_t mod_mask; /* depressed xkb modifier mask announced to the compositor */
  struct lease_gate lease; /* per-command control-lease proof */
};

static void out_free_ctx(struct ctx *c) { out_free(&c->events); }

/* Fatal error: one JSON line on stdout, clean disconnect, non-zero exit. */
static void fail(struct ctx *c, const char *fmt, ...) __attribute__((noreturn, format(printf, 2, 3)));
static void fail(struct ctx *c, const char *fmt, ...) {
  char msg[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);

  struct outbuf o = {0};
  out_printf(&o, "{\"ok\":false,\"error\":");
  out_json_string(&o, msg);
  out_printf(&o, "}");
  fwrite(o.buf, 1, o.len, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  out_free(&o);

  if (c != NULL && c->display != NULL) {
    wl_display_disconnect(c->display);
    c->display = NULL;
  }
  exit(1);
}

static void sleep_ms(int ms) {
  struct timespec ts = {.tv_sec = ms / 1000, .tv_nsec = (long)(ms % 1000) * 1000000L};
  while (nanosleep(&ts, &ts) < 0 && errno == EINTR) {
  }
}

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)((uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u);
}

static const char *display_error(struct ctx *c, char *buf, size_t buflen) {
  int err = wl_display_get_error(c->display);
  if (err == EPIPE) return "compositor disconnected";
  const struct wl_interface *iface = NULL;
  uint32_t id = 0;
  int code = wl_display_get_protocol_error(c->display, &iface, &id);
  if (iface != NULL) {
    snprintf(buf, buflen, "protocol error %d on %s@%u: %s", code, iface->name, id,
             err ? strerror(err) : "no details");
  } else if (err != 0) {
    snprintf(buf, buflen, "display error: %s", strerror(err));
  } else {
    snprintf(buf, buflen, "display roundtrip failed: %s", strerror(errno));
  }
  return buf;
}

static void flush_or_die(struct ctx *c) {
  if (wl_display_flush(c->display) < 0 && errno != EAGAIN) {
    char buf[512];
    fail(c, "%s", display_error(c, buf, sizeof buf));
  }
}

/* ------------------------------------------------------------------ */
/* registry / objects                                                 */
/* ------------------------------------------------------------------ */

static void on_global(void *data, struct wl_registry *registry, uint32_t name,
                      const char *interface, uint32_t version) {
  struct ctx *c = data;
  if (c->n_globals < MAX_GLOBALS) {
    struct global_info *g = &c->globals[c->n_globals++];
    snprintf(g->interface, sizeof g->interface, "%s", interface);
    g->name = name;
    g->version = version;
  }
  if (strcmp(interface, "wl_seat") == 0) {
    c->seat_count++;
    if (c->seat == NULL) {
      c->seat_name = name;
      uint32_t bind_version = version < 9 ? version : 9;
      c->seat = wl_registry_bind(registry, name, &wl_seat_interface, bind_version);
    }
  } else if (strcmp(interface, "zwlr_virtual_pointer_manager_v1") == 0) {
    if (c->vp_manager == NULL) {
      uint32_t bind_version = version < 2 ? version : 2;
      c->vp_manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface,
                                       bind_version);
      c->vp_name = name;
      c->vp_version = version;
    }
  } else if (strcmp(interface, "zwp_virtual_keyboard_manager_v1") == 0) {
    if (c->vk_manager == NULL) {
      uint32_t bind_version = version < 1 ? version : 1;
      c->vk_manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface,
                                       bind_version);
      c->vk_name = name;
      c->vk_version = version;
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
  (void)data;
  (void)seat;
  (void)capabilities;
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

/* memfd_create with a shm_open fallback; returns a read-only-ready fd. */
static int make_keymap_fd(size_t *size) {
  size_t len = strlen(KEYMAP_TEXT) + 1; /* include the NUL, as wl_keyboard does */
  int fd = memfd_create("hyprscope-keymap", MFD_CLOEXEC);
  if (fd < 0) {
    char name[64];
    snprintf(name, sizeof name, "/hyprscope-keymap-%ld", (long)getpid());
    fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0) shm_unlink(name);
  }
  if (fd < 0) return -1;
  if (ftruncate(fd, (off_t)len) < 0) {
    close(fd);
    return -1;
  }
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(fd, KEYMAP_TEXT + off, len - off);
    if (n <= 0) {
      close(fd);
      return -1;
    }
    off += (size_t)n;
  }
  *size = len;
  return fd;
}

static void shutdown_ctx(struct ctx *c) {
  if (c->display != NULL && wl_display_get_error(c->display) == 0) {
    if (c->pointer != NULL) {
      zwlr_virtual_pointer_v1_destroy(c->pointer);
      c->pointer = NULL;
    }
    if (c->keyboard != NULL) {
      zwp_virtual_keyboard_v1_destroy(c->keyboard);
      c->keyboard = NULL;
    }
    if (c->vp_manager != NULL) {
      zwlr_virtual_pointer_manager_v1_destroy(c->vp_manager);
      c->vp_manager = NULL;
    }
    if (c->vk_manager != NULL) {
      zwp_virtual_keyboard_manager_v1_destroy(c->vk_manager);
      c->vk_manager = NULL;
    }
    if (c->seat != NULL) {
      wl_seat_destroy(c->seat);
      c->seat = NULL;
    }
    if (c->registry != NULL) {
      wl_registry_destroy(c->registry);
      c->registry = NULL;
    }
    wl_display_flush(c->display);
  }
  if (c->display != NULL) {
    wl_display_disconnect(c->display);
    c->display = NULL;
  }
}

/* ------------------------------------------------------------------ */
/* event emitters: send for real, or record in --dry-run              */
/* ------------------------------------------------------------------ */

static void emit_event(struct ctx *c, const char *fmt, ...) {
  if (!c->dry_run) return;
  if (c->nevents++ > 0) out_printf(&c->events, ",");
  va_list ap;
  va_start(ap, fmt);
  out_vprintf(&c->events, fmt, ap);
  va_end(ap);
}

static void gap(struct ctx *c, int ms) {
  if (!c->dry_run) sleep_ms(ms);
}

/* xkbcommon modifier bit for a modifier key's evdev code (0 for normal keys). */
static uint32_t modifier_mask_for_key(uint32_t evdev) {
  switch (evdev) {
    case KEY_LEFTSHIFT:
    case KEY_RIGHTSHIFT:
      return WLI_MOD_SHIFT;
    case KEY_LEFTCTRL:
    case KEY_RIGHTCTRL:
      return WLI_MOD_CTRL;
    case KEY_LEFTALT:
    case KEY_RIGHTALT:
      return WLI_MOD_ALT;
    case KEY_LEFTMETA:
    case KEY_RIGHTMETA:
      return WLI_MOD_META;
    default:
      return 0;
  }
}

/* The wire `key` is the raw evdev keycode.  Hyprland 0.57.2's virtual-keyboard
 * resource stores it directly as its internal keycode and lets xkbcommon add
 * the +8 itself (wlroots does the same; wtype sends raw evdev too).  Sending
 * evdev+8 shifts every key one row (KEY_A -> 'l').  Hyprland also does not
 * derive modifier state from virtual key events, so modifier presses/releases
 * are mirrored through the protocol's modifiers request. */
static void emit_key(struct ctx *c, uint32_t evdev, bool pressed) {
  if (c->dry_run) {
    emit_event(c, "{\"keycode\":%u,\"state\":\"%s\"}", evdev,
               pressed ? "press" : "release");
    return;
  }
  zwp_virtual_keyboard_v1_key(c->keyboard, now_ms(), evdev,
                              pressed ? WL_KEYBOARD_KEY_STATE_PRESSED
                                      : WL_KEYBOARD_KEY_STATE_RELEASED);
  uint32_t bit = modifier_mask_for_key(evdev);
  if (bit != 0) {
    if (pressed) {
      c->mod_mask |= bit;
    } else {
      c->mod_mask &= ~bit;
    }
    zwp_virtual_keyboard_v1_modifiers(c->keyboard, c->mod_mask, 0, 0, 0);
  }
}

static void emit_motion_absolute(struct ctx *c, long x, long y) {
  uint32_t ax = x < 0 ? 0u : (uint32_t)x;
  uint32_t ay = y < 0 ? 0u : (uint32_t)y;
  if (ax > c->extent_w) ax = c->extent_w;
  if (ay > c->extent_h) ay = c->extent_h;
  if (c->dry_run) {
    emit_event(c,
               "{\"request\":\"motion_absolute\",\"x\":%u,\"y\":%u,"
               "\"x_extent\":%u,\"y_extent\":%u}",
               ax, ay, c->extent_w, c->extent_h);
    return;
  }
  zwlr_virtual_pointer_v1_motion_absolute(c->pointer, now_ms(), ax, ay, c->extent_w,
                                          c->extent_h);
  zwlr_virtual_pointer_v1_frame(c->pointer);
}

static void emit_motion_relative(struct ctx *c, long dx, long dy) {
  if (c->dry_run) {
    emit_event(c, "{\"request\":\"motion\",\"dx\":%ld,\"dy\":%ld}", dx, dy);
    return;
  }
  zwlr_virtual_pointer_v1_motion(c->pointer, now_ms(), wl_fixed_from_int((int)dx),
                                 wl_fixed_from_int((int)dy));
  zwlr_virtual_pointer_v1_frame(c->pointer);
}

static void emit_button(struct ctx *c, uint32_t button, bool pressed) {
  if (c->dry_run) {
    emit_event(c, "{\"request\":\"button\",\"button\":%u,\"state\":\"%s\"}", button,
               pressed ? "press" : "release");
    return;
  }
  zwlr_virtual_pointer_v1_button(c->pointer, now_ms(), button,
                                 pressed ? WL_POINTER_BUTTON_STATE_PRESSED
                                         : WL_POINTER_BUTTON_STATE_RELEASED);
  zwlr_virtual_pointer_v1_frame(c->pointer);
}

/* value is an integer number of wheel "steps"; it reaches the wire as
 * wl_fixed_from_int(value).  axis_discrete is preferred when the command
 * supplies a discrete step count, so the scroll is not applied twice. */
static void emit_axis(struct ctx *c, uint32_t axis, int value, bool has_discrete,
                      long discrete) {
  if (c->dry_run) {
    const char *axis_name =
        axis == WL_POINTER_AXIS_VERTICAL_SCROLL ? "vertical" : "horizontal";
    if (has_discrete) {
      emit_event(c,
                 "{\"request\":\"axis_discrete\",\"axis\":\"%s\",\"value\":%d,"
                 "\"wl_fixed_value\":%d,\"discrete\":%ld}",
                 axis_name, value, value * 256, discrete);
    } else {
      emit_event(c,
                 "{\"request\":\"axis\",\"axis\":\"%s\",\"value\":%d,"
                 "\"wl_fixed_value\":%d}",
                 axis_name, value, value * 256);
    }
    return;
  }
  zwlr_virtual_pointer_v1_axis_source(c->pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
  if (has_discrete) {
    zwlr_virtual_pointer_v1_axis_discrete(c->pointer, now_ms(), axis,
                                          wl_fixed_from_int(value), (int32_t)discrete);
  } else {
    zwlr_virtual_pointer_v1_axis(c->pointer, now_ms(), axis, wl_fixed_from_int(value));
  }
  zwlr_virtual_pointer_v1_frame(c->pointer);
}

/* Connect, create the virtual devices and send the keymap. */
static void connect_display(struct ctx *c, const char *runtime) {
  c->display = wl_display_connect(NULL);
  if (c->display == NULL) {
    fail(c, "cannot connect to Wayland display \"%s\" under %s: %s", c->display_name,
         runtime, strerror(errno));
  }
  c->registry = wl_display_get_registry(c->display);
  if (c->registry == NULL) fail(c, "cannot create wl_registry");
  wl_registry_add_listener(c->registry, &REGISTRY_LISTENER, c);
  if (wl_display_roundtrip(c->display) < 0) {
    char buf[512];
    fail(c, "registry roundtrip failed: %s", display_error(c, buf, sizeof buf));
  }
}

static void send_keymap(struct ctx *c) {
  size_t size = 0;
  int fd = make_keymap_fd(&size);
  if (fd < 0) fail(c, "cannot create keymap fd: %s", strerror(errno));
  zwp_virtual_keyboard_v1_keymap(c->keyboard, KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)size);
  if (wl_display_roundtrip(c->display) < 0) {
    char buf[512];
    const char *detail = display_error(c, buf, sizeof buf);
    close(fd);
    fail(c, "keymap rejected: %s", detail);
  }
  close(fd);
  /* Hyprland needs the modifier state spelled out (it is not derived from the
   * virtual key events); start from a clean, known state. */
  zwp_virtual_keyboard_v1_modifiers(c->keyboard, 0, 0, 0, 0);
  c->mod_mask = 0;
}

static void setup_input(struct ctx *c) {
  if (c->seat_count == 0) fail(c, "no wl_seat global is advertised");
  if (c->vp_manager == NULL) fail(c, "zwlr_virtual_pointer_manager_v1 is not advertised");
  if (c->vk_manager == NULL) fail(c, "zwp_virtual_keyboard_manager_v1 is not advertised");

  wl_seat_add_listener(c->seat, &SEAT_LISTENER, c);
  c->pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(c->vp_manager, c->seat);
  if (c->pointer == NULL) fail(c, "cannot create a virtual pointer");
  c->keyboard =
      zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(c->vk_manager, c->seat);
  if (c->keyboard == NULL) fail(c, "cannot create a virtual keyboard");
  send_keymap(c);
  if (wl_display_roundtrip(c->display) < 0) {
    char buf[512];
    fail(c, "virtual device setup failed: %s", display_error(c, buf, sizeof buf));
  }
}

#endif /* WLI_WAYLAND_H */

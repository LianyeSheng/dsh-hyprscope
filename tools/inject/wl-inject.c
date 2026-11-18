/*
 * wl-inject -- newline-delimited JSON input injector for Hyprland/Wayland.
 *
 * The helper is meant to run outside the graphical session: it is told which
 * Wayland socket to use (--display, or the display name stored on line 2 of
 * $XDG_RUNTIME_DIR/hypr/<signature>/hyprland.lock) and connects with
 * wayland-client only.  Events are produced through the wlr virtual pointer
 * and zwp virtual keyboard unstable protocols.
 *
 * Commands (one JSON object per stdin line) and their results are documented
 * in README of this tooling directory; every command produces exactly one
 * JSON line on stdout, flushed immediately.  A fatal protocol error produces
 * {"ok":false,"error":"..."} and a non-zero exit.
 *
 * --probe   connect, print the advertised globals/managers as JSON and exit.
 * --dry-run read commands but never connect: print the wire/keycode actions
 *           that would have been sent.  Useful for verifying the US layout
 *           mapping without touching the live desktop.
 *
 * Mutating commands are gated on the control lease: with
 * --lease-state <path> --lease <id> the helper re-reads the lease state file
 * before every such command and refuses to inject unless the lease is granted,
 * matches, approves a submitted plan and has not expired.  Without the gate
 * arguments mutating commands are refused; `sync`, --probe and --dry-run still
 * work.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "json.h"
#include "keys.h"
#include "wayland.h"

#define DEFAULT_EXTENT 16384u
#define MAX_CHORD_KEYS 16

/* ------------------------------------------------------------------ */
/* command handlers                                                   */
/* ------------------------------------------------------------------ */

static void out_ok(struct ctx *c, struct outbuf *o, const char *op) {
  out_reset(o);
  if (!c->dry_run) {
    out_printf(o, "{\"ok\":true}");
    return;
  }
  out_printf(o, "{\"ok\":true,\"op\":\"%s\",\"events\":[", op);
  if (c->events.len > 0) out_printf(o, "%s", c->events.buf);
  out_printf(o, "]}");
}

static void op_move(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  long x, y;
  if (!json_int(cmd, "x", &x) || !json_int(cmd, "y", &y)) {
    out_error(out, "move requires integer \"x\" and \"y\"");
    return;
  }
  emit_motion_absolute(c, x, y);
  out_ok(c, out, "move");
}

static void op_move_rel(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  long dx, dy;
  if (!json_int(cmd, "dx", &dx) || !json_int(cmd, "dy", &dy)) {
    out_error(out, "moveRel requires integer \"dx\" and \"dy\"");
    return;
  }
  if (dx < -32767 || dx > 32767 || dy < -32767 || dy > 32767) {
    out_error(out, "moveRel offset out of wl_fixed range");
    return;
  }
  emit_motion_relative(c, dx, dy);
  out_ok(c, out, "moveRel");
}

static uint32_t button_from_name(const char *name) {
  if (strcmp(name, "left") == 0) return BTN_LEFT;
  if (strcmp(name, "right") == 0) return BTN_RIGHT;
  if (strcmp(name, "middle") == 0) return BTN_MIDDLE;
  if (strcmp(name, "back") == 0) return BTN_SIDE;
  if (strcmp(name, "forward") == 0) return BTN_EXTRA;
  return 0;
}

static void op_button(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  const char *name = json_str(cmd, "button");
  const char *action = json_str(cmd, "action");
  if (name == NULL || action == NULL) {
    out_error(out, "button requires \"button\" and \"action\"");
    return;
  }
  uint32_t button = button_from_name(name);
  if (button == 0) {
    out_error(out, "unsupported button \"%s\"", name);
    return;
  }
  if (strcmp(action, "press") == 0) {
    emit_button(c, button, true);
  } else if (strcmp(action, "release") == 0) {
    emit_button(c, button, false);
  } else if (strcmp(action, "click") == 0) {
    emit_button(c, button, true);
    gap(c, 20);
    emit_button(c, button, false);
  } else {
    out_error(out, "unsupported button action \"%s\"", action);
    return;
  }
  out_ok(c, out, "button");
}

static void op_scroll(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  long value;
  if (!json_int(cmd, "value", &value)) {
    out_error(out, "scroll requires integer \"value\"");
    return;
  }
  if (value < -32767 || value > 32767) {
    out_error(out, "scroll value out of wl_fixed range");
    return;
  }
  const char *axis_name = json_str(cmd, "axis");
  if (axis_name == NULL) {
    out_error(out, "scroll requires \"axis\" (\"vertical\" or \"horizontal\")");
    return;
  }
  uint32_t axis;
  if (strcmp(axis_name, "vertical") == 0) {
    axis = WL_POINTER_AXIS_VERTICAL_SCROLL;
  } else if (strcmp(axis_name, "horizontal") == 0) {
    axis = WL_POINTER_AXIS_HORIZONTAL_SCROLL;
  } else {
    out_error(out, "unsupported axis \"%s\"", axis_name);
    return;
  }
  struct jval *dv = json_get(cmd, "discrete");
  bool has_discrete = dv != NULL;
  long discrete = 0;
  if (has_discrete) {
    if (dv->type != J_NUM) {
      out_error(out, "scroll \"discrete\" must be an integer");
      return;
    }
    discrete = dv->num;
    if (discrete < INT32_MIN || discrete > INT32_MAX) {
      out_error(out, "scroll \"discrete\" out of range");
      return;
    }
  }
  emit_axis(c, axis, (int)value, has_discrete, discrete);
  out_ok(c, out, "scroll");
}

static void op_key(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  long keycode;
  const char *state = json_str(cmd, "state");
  if (!json_int(cmd, "keycode", &keycode) || state == NULL) {
    out_error(out, "key requires integer \"keycode\" and string \"state\"");
    return;
  }
  if (keycode < 0 || keycode > 0xFFFF) {
    out_error(out, "keycode out of range");
    return;
  }
  bool pressed;
  if (strcmp(state, "press") == 0) {
    pressed = true;
  } else if (strcmp(state, "release") == 0) {
    pressed = false;
  } else {
    out_error(out, "unsupported key state \"%s\"", state);
    return;
  }
  emit_key(c, (uint32_t)keycode, pressed);
  out_ok(c, out, "key");
}

static void op_keysym(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  const char *sym = json_str(cmd, "sym");
  if (sym == NULL) {
    out_error(out, "keysym requires string \"sym\"");
    return;
  }
  uint32_t code;
  int shift;
  if (!resolve_key_name(sym, &code, &shift)) {
    out_error(out, "unsupported keysym \"%s\"", sym);
    return;
  }
  if (shift) {
    emit_key(c, KEY_LEFTSHIFT, true);
    gap(c, 4);
  }
  emit_key(c, code, true);
  gap(c, 10);
  emit_key(c, code, false);
  if (shift) {
    gap(c, 4);
    emit_key(c, KEY_LEFTSHIFT, false);
  }
  out_ok(c, out, "keysym");
}

struct wire_event {
  uint32_t code;
  int press;
};

static void op_chord(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  struct jval *keys = json_get(cmd, "keys");
  if (keys == NULL || keys->type != J_ARR || keys->count == 0) {
    out_error(out, "chord requires a non-empty array \"keys\"");
    return;
  }
  if (keys->count > MAX_CHORD_KEYS) {
    out_error(out, "chord has too many keys (max %d)", MAX_CHORD_KEYS);
    return;
  }
  uint32_t codes[MAX_CHORD_KEYS];
  int shifts[MAX_CHORD_KEYS];
  for (int i = 0; i < keys->count; i++) {
    struct jval *k = keys->items[i];
    if (k->type != J_STR) {
      out_error(out, "chord key %d is not a string", i);
      return;
    }
    if (!resolve_key_name(k->str, &codes[i], &shifts[i])) {
      out_error(out, "unsupported chord key \"%s\"", k->str);
      return;
    }
  }
  struct wire_event events[MAX_CHORD_KEYS * 4];
  int n = 0;
  for (int i = 0; i < keys->count; i++) {
    if (shifts[i]) events[n++] = (struct wire_event){KEY_LEFTSHIFT, 1};
    events[n++] = (struct wire_event){codes[i], 1};
  }
  for (int i = keys->count - 1; i >= 0; i--) {
    events[n++] = (struct wire_event){codes[i], 0};
    if (shifts[i]) events[n++] = (struct wire_event){KEY_LEFTSHIFT, 0};
  }
  for (int i = 0; i < n; i++) {
    emit_key(c, events[i].code, events[i].press != 0);
    if (i + 1 < n) gap(c, 10);
  }
  out_ok(c, out, "chord");
}

/* Decode one UTF-8 code point; returns 1 on success, 0 on malformed input. */
static int utf8_decode(const char **pp, uint32_t *cp) {
  const unsigned char *s = (const unsigned char *)*pp;
  if (s[0] < 0x80) {
    *cp = s[0];
    *pp += 1;
    return 1;
  }
  int len;
  uint32_t v;
  if ((s[0] & 0xE0) == 0xC0) {
    len = 2;
    v = s[0] & 0x1Fu;
  } else if ((s[0] & 0xF0) == 0xE0) {
    len = 3;
    v = s[0] & 0x0Fu;
  } else if ((s[0] & 0xF8) == 0xF0) {
    len = 4;
    v = s[0] & 0x07u;
  } else {
    return 0;
  }
  for (int i = 1; i < len; i++) {
    if ((s[i] & 0xC0) != 0x80) return 0;
    v = (v << 6) | (uint32_t)(s[i] & 0x3Fu);
  }
  *cp = v;
  *pp += len;
  return 1;
}

static void op_text(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  const char *text = json_str(cmd, "text");
  if (text == NULL) {
    out_error(out, "text requires string \"text\"");
    return;
  }
  /* Validate the whole string first so an unsupported character can never
   * leave a half-typed line. */
  const char *p = text;
  while (*p != '\0') {
    uint32_t cp;
    if (!utf8_decode(&p, &cp)) {
      out_error(out, "invalid UTF-8 in text");
      return;
    }
    uint32_t code;
    int shift;
    if (!text_char_to_key(cp, &code, &shift)) {
      out_error(out, "unsupported character U+%04X", cp);
      return;
    }
  }
  p = text;
  while (*p != '\0') {
    uint32_t cp;
    if (!utf8_decode(&p, &cp)) break;
    uint32_t code;
    int shift;
    if (!text_char_to_key(cp, &code, &shift)) break;
    if (shift) {
      emit_key(c, KEY_LEFTSHIFT, true);
      gap(c, 8);
    }
    emit_key(c, code, true);
    gap(c, 8);
    emit_key(c, code, false);
    gap(c, 8);
    if (shift) {
      emit_key(c, KEY_LEFTSHIFT, false);
      gap(c, 8);
    }
  }
  out_ok(c, out, "text");
}

static void op_sync(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  (void)cmd;
  if (!c->dry_run && wl_display_roundtrip(c->display) < 0) {
    char buf[512];
    fail(c, "%s", display_error(c, buf, sizeof buf));
  }
  out_ok(c, out, "sync");
}

/* Commands that change the desktop and therefore require a granted lease.
 * `sync` is deliberately absent: it only round-trips the connection. */
static int op_is_mutating(const char *op) {
  static const char *const MUTATING[] = {"move", "moveRel", "button", "scroll",
                                         "key", "keysym", "chord", "text"};
  for (size_t i = 0; i < sizeof MUTATING / sizeof MUTATING[0]; i++) {
    if (strcmp(op, MUTATING[i]) == 0) return 1;
  }
  return 0;
}

static void handle_command(struct ctx *c, struct jval *cmd, struct outbuf *out) {
  if (cmd == NULL || cmd->type != J_OBJ) {
    out_error(out, "command must be a JSON object");
    return;
  }
  const char *op = json_str(cmd, "op");
  if (op == NULL) {
    out_error(out, "missing string \"op\"");
    return;
  }
  /* Lease gate: re-read the state before every mutating command, so a panic,
   * revocation or TTL expiry in the middle of a batch stops the very next
   * command instead of only the next process. */
  if (!c->dry_run && op_is_mutating(op)) {
    char reason[256];
    const char *why = lease_check(&c->lease, reason, sizeof reason);
    if (why != NULL) {
      out_error(out, "lease gate: %s", why);
      return;
    }
  }
  out_reset(&c->events);
  c->nevents = 0;
  if (strcmp(op, "move") == 0) {
    op_move(c, cmd, out);
  } else if (strcmp(op, "moveRel") == 0) {
    op_move_rel(c, cmd, out);
  } else if (strcmp(op, "button") == 0) {
    op_button(c, cmd, out);
  } else if (strcmp(op, "scroll") == 0) {
    op_scroll(c, cmd, out);
  } else if (strcmp(op, "key") == 0) {
    op_key(c, cmd, out);
  } else if (strcmp(op, "keysym") == 0) {
    op_keysym(c, cmd, out);
  } else if (strcmp(op, "chord") == 0) {
    op_chord(c, cmd, out);
  } else if (strcmp(op, "text") == 0) {
    op_text(c, cmd, out);
  } else if (strcmp(op, "sync") == 0) {
    op_sync(c, cmd, out);
  } else {
    out_error(out, "unknown op \"%s\"", op);
  }
}
/* ------------------------------------------------------------------ */
/* probe output                                                       */
/* ------------------------------------------------------------------ */

static void out_manager(struct outbuf *o, const char *interface, uint32_t name,
                        uint32_t version, int present) {
  out_printf(o, "\"%s\":{\"present\":%s", interface, present ? "true" : "false");
  if (present) out_printf(o, ",\"name\":%u,\"version\":%u", name, version);
  out_printf(o, "}");
}

static void print_probe(struct ctx *c) {
  struct outbuf o = {0};
  out_printf(&o, "{\"ok\":true,\"display\":");
  out_json_string(&o, c->display_name);
  out_printf(&o, ",\"seat_count\":%d,\"seat_name\":%u,\"managers\":{", c->seat_count,
             c->seat_name);
  out_manager(&o, "zwlr_virtual_pointer_manager_v1", c->vp_name, c->vp_version,
              c->vp_manager != NULL);
  out_printf(&o, ",");
  out_manager(&o, "zwp_virtual_keyboard_manager_v1", c->vk_name, c->vk_version,
              c->vk_manager != NULL);
  out_printf(&o, "},\"globals\":[");
  for (int i = 0; i < c->n_globals; i++) {
    if (i > 0) out_printf(&o, ",");
    out_printf(&o, "{\"name\":%u,\"interface\":", c->globals[i].name);
    out_json_string(&o, c->globals[i].interface);
    out_printf(&o, ",\"version\":%u}", c->globals[i].version);
  }
  out_printf(&o, "]}");
  fwrite(o.buf, 1, o.len, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  out_free(&o);
}
/* ------------------------------------------------------------------ */
/* startup: socket discovery, connect, bind, keymap                   */
/* ------------------------------------------------------------------ */

static int read_display_name(const char *runtime, const char *signature, char *out,
                             size_t outlen, char *err, size_t errlen) {
  char path[PATH_MAX];
  int n = snprintf(path, sizeof path, "%s/hypr/%s/hyprland.lock", runtime, signature);
  if (n < 0 || (size_t)n >= sizeof path) {
    snprintf(err, errlen, "session lock path is too long");
    return 0;
  }
  FILE *f = fopen(path, "r");
  if (f == NULL) {
    snprintf(err, errlen, "cannot open %.*s: %.*s", 200, path, 100, strerror(errno));
    return 0;
  }
  char line[256];
  if (fgets(line, sizeof line, f) == NULL || fgets(line, sizeof line, f) == NULL) {
    fclose(f);
    snprintf(err, errlen, "incomplete lock file (expected pid and display name)");
    return 0;
  }
  fclose(f);
  size_t len = strlen(line);
  while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r' ||
                     line[len - 1] == ' ' || line[len - 1] == '\t')) {
    line[--len] = '\0';
  }
  if (len == 0) {
    snprintf(err, errlen, "empty Wayland display name in session lock file");
    return 0;
  }
  snprintf(out, outlen, "%s", line);
  return 1;
}

/* ------------------------------------------------------------------ */
/* stdin command loop                                                 */
/* ------------------------------------------------------------------ */

static void run_commands(struct ctx *c) {
  struct outbuf out = {0};
  char *line = NULL;
  size_t cap = 0;
  ssize_t nread;

  while ((nread = getline(&line, &cap, stdin)) >= 0) {
    while (nread > 0 && (line[nread - 1] == '\n' || line[nread - 1] == '\r' ||
                         line[nread - 1] == ' ' || line[nread - 1] == '\t')) {
      line[--nread] = '\0';
    }
    if (nread == 0) continue;

    out_reset(&out);
    struct jval *cmd = json_parse(line);
    if (cmd == NULL) {
      out_error(&out, "invalid JSON");
    } else {
      handle_command(c, cmd, &out);
      jval_free(cmd);
    }
    if (!c->dry_run) flush_or_die(c);
    fwrite(out.buf, 1, out.len, stdout);
    fputc('\n', stdout);
    fflush(stdout);
  }
  free(line);
  out_free(&out);
}
/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

static void usage(FILE *f) {
  fputs(
      "usage: wl-inject --runtime-dir <dir> --signature <sig> [--display <wayland-display>]\n"
      "                 [--extent-width <n>] [--extent-height <n>]\n"
      "                 [--lease-state <path> --lease <id>]\n"
      "                 [--probe] [--dry-run]\n"
      "\n"
      "Reads newline-delimited JSON commands on stdin and writes one JSON result per\n"
      "command on stdout.  Sets WAYLAND_DISPLAY from --display, or from line 2 of\n"
      "<runtime-dir>/hypr/<signature>/hyprland.lock when --display is omitted.\n"
      "\n"
      "  --probe        connect, print advertised globals/managers, exit\n"
      "  --dry-run      do not connect; print the keycodes/wire actions instead\n"
      "  --lease-state  lease state.json re-read before every mutating command\n"
      "  --lease        expected leaseId; without both lease arguments mutating\n"
      "                 commands are refused (sync/probe/dry-run still work)\n",
      f);
}

static int parse_extent(const char *value, uint32_t *out) {
  char *end = NULL;
  errno = 0;
  unsigned long v = strtoul(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || v == 0 || v > UINT32_MAX) return 0;
  *out = (uint32_t)v;
  return 1;
}

static void try_env_extent(const char *name, uint32_t *out) {
  const char *value = getenv(name);
  if (value == NULL || *value == '\0') return;
  uint32_t parsed;
  if (parse_extent(value, &parsed)) *out = parsed;
}

int main(int argc, char **argv) {
  struct ctx c;
  memset(&c, 0, sizeof c);
  c.extent_w = DEFAULT_EXTENT;
  c.extent_h = DEFAULT_EXTENT;
  out_reset(&c.events);

  const char *runtime = NULL;
  const char *signature = NULL;
  const char *display = NULL;
  const char *lease_state = NULL;
  const char *lease_id = NULL;
  int extent_w_set = 0;
  int extent_h_set = 0;

  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (strcmp(arg, "--runtime-dir") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "wl-inject: --runtime-dir needs a value\n");
        return 2;
      }
      runtime = argv[i];
    } else if (strcmp(arg, "--signature") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "wl-inject: --signature needs a value\n");
        return 2;
      }
      signature = argv[i];
    } else if (strcmp(arg, "--display") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "wl-inject: --display needs a value\n");
        return 2;
      }
      display = argv[i];
    } else if (strcmp(arg, "--extent-width") == 0) {
      if (++i >= argc || !parse_extent(argv[i], &c.extent_w)) {
        fprintf(stderr, "wl-inject: --extent-width needs a positive integer\n");
        return 2;
      }
      extent_w_set = 1;
    } else if (strcmp(arg, "--extent-height") == 0) {
      if (++i >= argc || !parse_extent(argv[i], &c.extent_h)) {
        fprintf(stderr, "wl-inject: --extent-height needs a positive integer\n");
        return 2;
      }
      extent_h_set = 1;
    } else if (strcmp(arg, "--lease-state") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "wl-inject: --lease-state needs a value\n");
        return 2;
      }
      lease_state = argv[i];
    } else if (strcmp(arg, "--lease") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "wl-inject: --lease needs a value\n");
        return 2;
      }
      lease_id = argv[i];
    } else if (strcmp(arg, "--probe") == 0) {
      c.probe = 1;
    } else if (strcmp(arg, "--dry-run") == 0) {
      c.dry_run = 1;
    } else if (strcmp(arg, "-h") == 0 || strcmp(arg, "--help") == 0) {
      usage(stdout);
      out_free_ctx(&c);
      return 0;
    } else {
      fprintf(stderr, "wl-inject: unknown argument \"%s\"\n", arg);
      usage(stderr);
      out_free_ctx(&c);
      return 2;
    }
  }

  if (c.probe && c.dry_run) {
    fprintf(stderr, "wl-inject: --probe and --dry-run cannot be combined\n");
    out_free_ctx(&c);
    return 2;
  }
  if (runtime == NULL) {
    fprintf(stderr, "wl-inject: --runtime-dir is required\n");
    usage(stderr);
    out_free_ctx(&c);
    return 2;
  }
  if (signature == NULL && display == NULL) {
    fprintf(stderr, "wl-inject: --signature or --display is required\n");
    usage(stderr);
    out_free_ctx(&c);
    return 2;
  }
  if (!extent_w_set) try_env_extent("HYPRSCOPE_EXTENT_WIDTH", &c.extent_w);
  if (!extent_h_set) try_env_extent("HYPRSCOPE_EXTENT_HEIGHT", &c.extent_h);

  c.lease.state_path = lease_state;
  c.lease.lease_id = lease_id;
  if (lease_state != NULL && lease_id != NULL) {
    c.lease.enabled = 1;
  } else if (lease_state == NULL && lease_id == NULL) {
    c.lease.enabled = 0;
    c.lease.disabled_reason = "no lease provided";
  } else if (lease_state == NULL || lease_id == NULL) {
    c.lease.enabled = 0;
    c.lease.disabled_reason = "incomplete lease arguments (need --lease-state and --lease)";
  }

  setenv("XDG_RUNTIME_DIR", runtime, 1);
  if (display != NULL) {
    snprintf(c.display_name, sizeof c.display_name, "%s", display);
  } else if (c.dry_run) {
    snprintf(c.display_name, sizeof c.display_name, "(dry-run)");
  } else {
    char err[512];
    if (!read_display_name(runtime, signature, c.display_name, sizeof c.display_name, err,
                           sizeof err)) {
      fail(&c, "%s", err);
    }
  }

  if (!c.dry_run) {
    setenv("WAYLAND_DISPLAY", c.display_name, 1);
    connect_display(&c, runtime);
  }
  if (c.probe) {
    print_probe(&c);
    shutdown_ctx(&c);
    out_free_ctx(&c);
    return 0;
  }
  if (!c.dry_run) setup_input(&c);

  run_commands(&c);

  shutdown_ctx(&c);
  out_free_ctx(&c);
  return 0;
}

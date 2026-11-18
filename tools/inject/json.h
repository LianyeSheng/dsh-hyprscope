#ifndef WLI_JSON_H
#define WLI_JSON_H

/* JSON command parser and JSON output buffer.  The parser works in place on
 * the stdin line, so no allocation is needed for strings; every parsed value
 * is still freed by jval_free() before the next command is read. */
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_JSON_DEPTH 8

/* ------------------------------------------------------------------ */
/* growable output buffer                                             */
/* ------------------------------------------------------------------ */

struct outbuf {
  char *buf;
  size_t len;
  size_t cap;
};

static void out_reset(struct outbuf *o) {
  o->len = 0;
  if (o->buf != NULL) o->buf[0] = '\0';
}

static void out_free(struct outbuf *o) {
  free(o->buf);
  o->buf = NULL;
  o->len = o->cap = 0;
}

static int out_reserve(struct outbuf *o, size_t extra) {
  size_t need = o->len + extra + 1;
  if (o->cap >= need) return 1;
  size_t cap = o->cap ? o->cap : 512;
  while (cap < need) cap *= 2;
  char *nbuf = realloc(o->buf, cap);
  if (nbuf == NULL) return 0;
  o->buf = nbuf;
  o->cap = cap;
  return 1;
}

static void out_vprintf(struct outbuf *o, const char *fmt, va_list ap) {
  va_list measure;
  va_copy(measure, ap);
  int n = vsnprintf(NULL, 0, fmt, measure);
  va_end(measure);
  if (n < 0) return;
  if (!out_reserve(o, (size_t)n)) return;
  vsnprintf(o->buf + o->len, (size_t)n + 1, fmt, ap);
  o->len += (size_t)n;
}

static void out_printf(struct outbuf *o, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  out_vprintf(o, fmt, ap);
  va_end(ap);
}

/* Append a JSON string literal, escaping as required. */
static void out_json_string(struct outbuf *o, const char *s) {
  size_t n = strlen(s);
  char *tmp = malloc(n * 6 + 3);
  if (tmp == NULL) return;
  size_t w = 0;
  tmp[w++] = '"';
  for (size_t i = 0; i < n; i++) {
    unsigned char ch = (unsigned char)s[i];
    switch (ch) {
      case '"': tmp[w++] = '\\'; tmp[w++] = '"'; break;
      case '\\': tmp[w++] = '\\'; tmp[w++] = '\\'; break;
      case '\b': tmp[w++] = '\\'; tmp[w++] = 'b'; break;
      case '\f': tmp[w++] = '\\'; tmp[w++] = 'f'; break;
      case '\n': tmp[w++] = '\\'; tmp[w++] = 'n'; break;
      case '\r': tmp[w++] = '\\'; tmp[w++] = 'r'; break;
      case '\t': tmp[w++] = '\\'; tmp[w++] = 't'; break;
      default:
        if (ch < 0x20) {
          w += (size_t)snprintf(tmp + w, 7, "\\u%04x", (unsigned)ch);
        } else {
          tmp[w++] = (char)ch;
        }
    }
  }
  tmp[w++] = '"';
  if (out_reserve(o, w)) {
    memcpy(o->buf + o->len, tmp, w);
    o->len += w;
    o->buf[o->len] = '\0';
  }
  free(tmp);
}

/* ------------------------------------------------------------------ */
/* minimal JSON parser (enough for the command objects)               */
/* ------------------------------------------------------------------ */

enum jtype { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ };

struct jval {
  enum jtype type;
  long num;
  char *str;           /* J_STR, points into the parsed line */
  struct jval **items; /* J_ARR / J_OBJ values */
  char **keys;         /* J_OBJ keys, point into the parsed line */
  int count;
};

struct jparser {
  char *p;
  int depth;
};

static void jval_free(struct jval *v) {
  if (v == NULL) return;
  for (int i = 0; i < v->count; i++) jval_free(v->items[i]);
  free(v->items);
  free(v->keys);
  free(v);
}

static int jval_append(struct jval *v, char *key, struct jval *item) {
  struct jval **items = realloc(v->items, sizeof *items * (size_t)(v->count + 1));
  if (items == NULL) return 0;
  v->items = items;
  if (v->type == J_OBJ) {
    char **keys = realloc(v->keys, sizeof *keys * (size_t)(v->count + 1));
    if (keys == NULL) return 0;
    v->keys = keys;
    v->keys[v->count] = key;
  }
  v->items[v->count++] = item;
  return 1;
}

static struct jval *jval_new(enum jtype type) {
  struct jval *v = calloc(1, sizeof *v);
  if (v != NULL) v->type = type;
  return v;
}

static void json_skip_ws(struct jparser *jp) {
  while (*jp->p == ' ' || *jp->p == '\t' || *jp->p == '\n' || *jp->p == '\r') jp->p++;
}

static int json_hex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int utf8_encode(uint32_t cp, char *out) {
  if (cp < 0x80) {
    out[0] = (char)cp;
    return 1;
  }
  if (cp < 0x800) {
    out[0] = (char)(0xC0u | (cp >> 6));
    out[1] = (char)(0x80u | (cp & 0x3Fu));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0u | (cp >> 12));
    out[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
    out[2] = (char)(0x80u | (cp & 0x3Fu));
    return 3;
  }
  out[0] = (char)(0xF0u | (cp >> 18));
  out[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
  out[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
  out[3] = (char)(0x80u | (cp & 0x3Fu));
  return 4;
}

/* Decode a JSON string in place: escapes shrink, so the result never
 * overtakes the read cursor and stays inside the input buffer. */
static char *json_parse_string(struct jparser *jp) {
  if (*jp->p != '"') return NULL;
  jp->p++;
  char *start = jp->p;
  char *out = start;
  while (*jp->p != '\0') {
    unsigned char ch = (unsigned char)*jp->p;
    if (ch == '"') {
      *out = '\0';
      jp->p++;
      return start;
    }
    if (ch == '\\') {
      jp->p++;
      switch (*jp->p) {
        case '"': *out++ = '"'; jp->p++; break;
        case '\\': *out++ = '\\'; jp->p++; break;
        case '/': *out++ = '/'; jp->p++; break;
        case 'b': *out++ = '\b'; jp->p++; break;
        case 'f': *out++ = '\f'; jp->p++; break;
        case 'n': *out++ = '\n'; jp->p++; break;
        case 'r': *out++ = '\r'; jp->p++; break;
        case 't': *out++ = '\t'; jp->p++; break;
        case 'u': {
          jp->p++;
          uint32_t cp = 0;
          for (int i = 0; i < 4; i++) {
            int d = json_hex(jp->p[i]);
            if (d < 0) return NULL;
            cp = (cp << 4) | (uint32_t)d;
          }
          jp->p += 4;
          out += utf8_encode(cp, out);
          break;
        }
        default: return NULL;
      }
    } else if (ch < 0x20) {
      return NULL;
    } else {
      *out++ = (char)ch;
      jp->p++;
    }
  }
  return NULL;
}

static struct jval *json_parse_value(struct jparser *jp);

static struct jval *json_parse_array(struct jparser *jp) {
  jp->p++; /* '[' */
  struct jval *v = jval_new(J_ARR);
  if (v == NULL) return NULL;
  jp->depth++;
  json_skip_ws(jp);
  if (*jp->p == ']') {
    jp->p++;
    jp->depth--;
    return v;
  }
  for (;;) {
    struct jval *item = json_parse_value(jp);
    if (item == NULL || !jval_append(v, NULL, item)) {
      jval_free(item);
      jval_free(v);
      jp->depth--;
      return NULL;
    }
    json_skip_ws(jp);
    if (*jp->p == ',') {
      jp->p++;
      continue;
    }
    if (*jp->p == ']') {
      jp->p++;
      jp->depth--;
      return v;
    }
    jval_free(v);
    jp->depth--;
    return NULL;
  }
}

static struct jval *json_parse_object(struct jparser *jp) {
  jp->p++; /* '{' */
  struct jval *v = jval_new(J_OBJ);
  if (v == NULL) return NULL;
  jp->depth++;
  json_skip_ws(jp);
  if (*jp->p == '}') {
    jp->p++;
    jp->depth--;
    return v;
  }
  for (;;) {
    json_skip_ws(jp);
    char *key = json_parse_string(jp);
    if (key == NULL) goto fail;
    json_skip_ws(jp);
    if (*jp->p != ':') goto fail;
    jp->p++;
    struct jval *item = json_parse_value(jp);
    if (item == NULL || !jval_append(v, key, item)) {
      jval_free(item);
      goto fail;
    }
    json_skip_ws(jp);
    if (*jp->p == ',') {
      jp->p++;
      continue;
    }
    if (*jp->p == '}') {
      jp->p++;
      jp->depth--;
      return v;
    }
    goto fail;
  }
fail:
  jval_free(v);
  jp->depth--;
  return NULL;
}

static struct jval *json_parse_value(struct jparser *jp) {
  json_skip_ws(jp);
  if (jp->depth >= MAX_JSON_DEPTH) return NULL;
  switch (*jp->p) {
    case '{': return json_parse_object(jp);
    case '[': return json_parse_array(jp);
    case '"': {
      char *s = json_parse_string(jp);
      if (s == NULL) return NULL;
      struct jval *v = jval_new(J_STR);
      if (v != NULL) v->str = s;
      return v;
    }
    case 't':
      if (strncmp(jp->p, "true", 4) != 0) return NULL;
      jp->p += 4;
      {
        struct jval *v = jval_new(J_BOOL);
        if (v != NULL) v->num = 1;
        return v;
      }
    case 'f':
      if (strncmp(jp->p, "false", 5) != 0) return NULL;
      jp->p += 5;
      return jval_new(J_BOOL);
    case 'n':
      if (strncmp(jp->p, "null", 4) != 0) return NULL;
      jp->p += 4;
      return jval_new(J_NULL);
    default: {
      char *end = NULL;
      long num = strtol(jp->p, &end, 10);
      if (end == jp->p) return NULL;
      jp->p = end;
      struct jval *v = jval_new(J_NUM);
      if (v != NULL) v->num = num;
      return v;
    }
  }
}

static struct jval *json_parse(char *text) {
  struct jparser jp = {.p = text, .depth = 0};
  struct jval *v = json_parse_value(&jp);
  if (v == NULL) return NULL;
  json_skip_ws(&jp);
  if (*jp.p != '\0') {
    jval_free(v);
    return NULL;
  }
  return v;
}

static struct jval *json_get(struct jval *obj, const char *key) {
  if (obj == NULL || obj->type != J_OBJ) return NULL;
  for (int i = 0; i < obj->count; i++) {
    if (obj->keys[i] != NULL && strcmp(obj->keys[i], key) == 0) return obj->items[i];
  }
  return NULL;
}

static bool json_int(struct jval *obj, const char *key, long *out) {
  struct jval *v = json_get(obj, key);
  if (v == NULL || v->type != J_NUM) return false;
  *out = v->num;
  return true;
}

static const char *json_str(struct jval *obj, const char *key) {
  struct jval *v = json_get(obj, key);
  if (v == NULL || v->type != J_STR) return NULL;
  return v->str;
}
static void out_error(struct outbuf *o, const char *fmt, ...) {
  char msg[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  out_reset(o);
  out_printf(o, "{\"ok\":false,\"error\":");
  out_json_string(o, msg);
  out_printf(o, "}");
}

#endif /* WLI_JSON_H */

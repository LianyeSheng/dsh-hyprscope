#ifndef WLI_LEASE_H
#define WLI_LEASE_H

/*
 * Control-lease gate for the injection helper.
 *
 * The consent overlay lives on the same seat as the virtual pointer/keyboard,
 * so the helper itself must refuse to inject unless a granted lease proves the
 * human handed control over.  The state file is re-read for every mutating
 * command: the host may revoke (panic/TTL) in the middle of a batch, and the
 * very next command must already see that.
 *
 * The file is written by src/lease/state.ts via writeJsonAtomic(); the fields
 * used here are flat and small, so a read + reuse of the tiny JSON parser is
 * enough.  Nothing about the gate is cached between commands.
 */

#include <ctype.h>
#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "json.h"

/* Refuse to slurp absurdly large files; real state records are < 4 KiB. */
#define WLI_LEASE_MAX_BYTES (1024u * 1024u)

struct lease_gate {
  const char *state_path;      /* --lease-state, NULL when not supplied */
  const char *lease_id;        /* --lease, NULL when not supplied */
  int enabled;                 /* state_path && lease_id supplied */
  const char *disabled_reason; /* why the gate refuses when not enabled */
};

/* Read a whole file into a NUL-terminated heap buffer. */
static int lease_read_file(const char *path, char **data, size_t *length) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return 0;

  size_t cap = 1024;
  size_t len = 0;
  char *buf = malloc(cap);
  if (buf == NULL) {
    fclose(file);
    errno = ENOMEM;
    return 0;
  }

  for (;;) {
    if (len + 1 >= cap) {
      if (cap >= WLI_LEASE_MAX_BYTES) {
        free(buf);
        fclose(file);
        errno = EFBIG;
        return 0;
      }
      size_t next = cap * 2;
      char *grown = realloc(buf, next);
      if (grown == NULL) {
        free(buf);
        fclose(file);
        errno = ENOMEM;
        return 0;
      }
      buf = grown;
      cap = next;
    }
    size_t got = fread(buf + len, 1, cap - len - 1, file);
    len += got;
    if (got == 0) {
      if (ferror(file)) {
        free(buf);
        fclose(file);
        if (errno == 0) errno = EIO;
        return 0;
      }
      break;
    }
    if (len >= WLI_LEASE_MAX_BYTES) {
      free(buf);
      fclose(file);
      errno = EFBIG;
      return 0;
    }
  }
  fclose(file);
  buf[len] = '\0';
  *data = buf;
  *length = len;
  return 1;
}

/*
 * Parse the state writer's UTC timestamp: YYYY-MM-DDTHH:MM:SS[.fraction]Z.
 * Deliberately strict: a missing/multiple Z, an offset suffix, or a bare date
 * is rejected instead of being silently reinterpreted.  Fractions are accepted
 * with 1..9 digits but compared at second granularity.
 */
static int lease_parse_utc(const char *text, time_t *out) {
  if (text == NULL || *text == '\0') return 0;

  struct tm tm;
  memset(&tm, 0, sizeof tm);
  const char *rest = strptime(text, "%Y-%m-%dT%H:%M:%S", &tm);
  if (rest == NULL) return 0;

  if (*rest == '.') {
    rest++;
    const char *digits = rest;
    while (isdigit((unsigned char)*rest)) rest++;
    if (rest == digits || (size_t)(rest - digits) > 9) return 0;
  }
  if (*rest != 'Z' || rest[1] != '\0') return 0;

  if (tm.tm_mon < 0 || tm.tm_mon > 11 || tm.tm_mday < 1 || tm.tm_mday > 31 ||
      tm.tm_hour < 0 || tm.tm_hour > 23 || tm.tm_min < 0 || tm.tm_min > 59 ||
      tm.tm_sec < 0 || tm.tm_sec > 59) {
    return 0;
  }

  errno = 0;
  time_t value = timegm(&tm);
  if (value == (time_t)-1 && errno == EOVERFLOW) return 0;
  *out = value;
  return 1;
}

/*
 * Check the lease proof.
 * @returns NULL when injection is allowed, otherwise a reason string.  The
 *          reason may point at a static literal or into `reason`.
 */
static const char *lease_check(const struct lease_gate *gate, char *reason,
                               size_t reason_size) {
  if (!gate->enabled) {
    return gate->disabled_reason != NULL ? gate->disabled_reason : "no lease provided";
  }

  char *text = NULL;
  size_t length = 0;
  if (!lease_read_file(gate->state_path, &text, &length)) {
    snprintf(reason, reason_size, "cannot read lease state: %s", strerror(errno));
    return reason;
  }

  const char *why = NULL;
  struct jval *state = json_parse(text);
  if (state == NULL || state->type != J_OBJ) {
    why = "invalid lease state JSON";
    goto done;
  }

  const char *phase = json_str(state, "phase");
  if (phase == NULL) {
    why = "missing \"phase\"";
    goto done;
  }
  if (strcmp(phase, "granted") != 0) {
    snprintf(reason, reason_size, "phase is \"%.64s\", not \"granted\"", phase);
    why = reason;
    goto done;
  }

  const char *lease_id = json_str(state, "leaseId");
  if (lease_id == NULL) {
    why = "missing \"leaseId\"";
    goto done;
  }
  if (strcmp(lease_id, gate->lease_id) != 0) {
    why = "lease id mismatch";
    goto done;
  }

  struct jval *plan_bound = json_get(state, "planBound");
  if (plan_bound == NULL || plan_bound->type != J_BOOL) {
    why = "missing \"planBound\"";
    goto done;
  }
  if (!plan_bound->num) {
    why = "the lease does not approve a submitted plan";
    goto done;
  }

  const char *expires = json_str(state, "expiresAt");
  if (expires == NULL) {
    why = "missing \"expiresAt\"";
    goto done;
  }
  time_t expires_at;
  if (!lease_parse_utc(expires, &expires_at)) {
    why = "invalid \"expiresAt\"";
    goto done;
  }
  if (expires_at <= time(NULL)) {
    why = "lease expired";
    goto done;
  }

done:
  jval_free(state);
  free(text);
  return why;
}

#endif /* WLI_LEASE_H */

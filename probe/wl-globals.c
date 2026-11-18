/** Minimal Wayland registry probe: prints every global and the wl_seat count. */
#include <stdio.h>
#include <string.h>
#include <wayland-client.h>

static unsigned seats;

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  (void)registry;
  (void)name;
  printf("%s\t%u\n", interface, version);
  if (strcmp(interface, "wl_seat") == 0) seats++;
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener listener = { global, global_remove };

int main(void) {
  struct wl_display *display = wl_display_connect(NULL);
  if (display == NULL) {
    fprintf(stderr, "wl_globals: cannot connect to the Wayland display\n");
    return 1;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  if (registry == NULL) {
    fprintf(stderr, "wl_globals: cannot create the registry\n");
    wl_display_disconnect(display);
    return 1;
  }
  wl_registry_add_listener(registry, &listener, NULL);
  if (wl_display_roundtrip(display) < 0) {
    fprintf(stderr, "wl_globals: registry roundtrip failed\n");
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return 1;
  }
  printf("seat-count\t%u\n", seats);
  wl_registry_destroy(registry);
  wl_display_disconnect(display);
  return 0;
}

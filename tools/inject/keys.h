#ifndef WLI_KEYS_H
#define WLI_KEYS_H

/* US QWERTY (evdev) keycode mapping used by the keysym, chord and text ops. */
#include <linux/input-event-codes.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* US keyboard mapping                                                */
/* ------------------------------------------------------------------ */

static const unsigned char LETTER_KEYCODES[26] = {
    KEY_A, KEY_B, KEY_C, KEY_D, KEY_E, KEY_F, KEY_G, KEY_H, KEY_I,
    KEY_J, KEY_K, KEY_L, KEY_M, KEY_N, KEY_O, KEY_P, KEY_Q, KEY_R,
    KEY_S, KEY_T, KEY_U, KEY_V, KEY_W, KEY_X, KEY_Y, KEY_Z,
};

struct punct_key {
  char plain;
  char shifted;
  unsigned short code;
};

static const struct punct_key PUNCT_KEYS[] = {
    /* shifted variants of the digit row (!@#$%^&*() ) */
    {0, '!', KEY_1},            {0, '@', KEY_2},
    {0, '#', KEY_3},            {0, '$', KEY_4},
    {0, '%', KEY_5},            {0, '^', KEY_6},
    {0, '&', KEY_7},            {0, '*', KEY_8},
    {0, '(', KEY_9},            {0, ')', KEY_0},
    {'-', '_', KEY_MINUS},      {'=', '+', KEY_EQUAL},
    {'[', '{', KEY_LEFTBRACE},  {']', '}', KEY_RIGHTBRACE},
    {';', ':', KEY_SEMICOLON},  {'\'', '"', KEY_APOSTROPHE},
    {'`', '~', KEY_GRAVE},      {'\\', '|', KEY_BACKSLASH},
    {',', '<', KEY_COMMA},      {'.', '>', KEY_DOT},
    {'/', '?', KEY_SLASH},
};

struct named_key {
  const char *name;
  unsigned short code;
};

static const struct named_key NAMED_KEYS[] = {
    {"Escape", KEY_ESC},        {"Esc", KEY_ESC},
    {"Return", KEY_ENTER},      {"Enter", KEY_ENTER},
    {"Tab", KEY_TAB},           {"Backspace", KEY_BACKSPACE},
    {"Delete", KEY_DELETE},     {"Insert", KEY_INSERT},
    {"Home", KEY_HOME},         {"End", KEY_END},
    {"Page_Up", KEY_PAGEUP},    {"PageUp", KEY_PAGEUP},
    {"Page_Down", KEY_PAGEDOWN}, {"PageDown", KEY_PAGEDOWN},
    {"Up", KEY_UP},             {"Down", KEY_DOWN},
    {"Left", KEY_LEFT},         {"Right", KEY_RIGHT},
    {"F1", KEY_F1},             {"F2", KEY_F2},
    {"F3", KEY_F3},             {"F4", KEY_F4},
    {"F5", KEY_F5},             {"F6", KEY_F6},
    {"F7", KEY_F7},             {"F8", KEY_F8},
    {"F9", KEY_F9},             {"F10", KEY_F10},
    {"F11", KEY_F11},           {"F12", KEY_F12},
    {"space", KEY_SPACE},
    {"LEFTCTRL", KEY_LEFTCTRL}, {"LEFTSHIFT", KEY_LEFTSHIFT},
    {"LEFTALT", KEY_LEFTALT},   {"LEFTMETA", KEY_LEFTMETA},
    {"RIGHTCTRL", KEY_RIGHTCTRL}, {"RIGHTSHIFT", KEY_RIGHTSHIFT},
    {"RIGHTALT", KEY_RIGHTALT}, {"RIGHTMETA", KEY_RIGHTMETA},
};

/* US QWERTY character -> (evdev keycode, needs LEFTSHIFT). */
static bool text_char_to_key(uint32_t cp, uint32_t *code, int *shift) {
  if (cp > 0x7Fu) return false;
  char ch = (char)cp;
  *shift = 0;
  if (ch == ' ') {
    *code = KEY_SPACE;
    return true;
  }
  if (ch == '\n') {
    *code = KEY_ENTER;
    return true;
  }
  if (ch == '\t') {
    *code = KEY_TAB;
    return true;
  }
  if (ch >= 'a' && ch <= 'z') {
    *code = LETTER_KEYCODES[ch - 'a'];
    return true;
  }
  if (ch >= 'A' && ch <= 'Z') {
    *code = LETTER_KEYCODES[ch - 'A'];
    *shift = 1;
    return true;
  }
  if (ch >= '0' && ch <= '9') {
    *code = (ch == '0') ? KEY_0 : (uint32_t)(KEY_1 + (ch - '1'));
    return true;
  }
  for (size_t i = 0; i < sizeof PUNCT_KEYS / sizeof PUNCT_KEYS[0]; i++) {
    if (PUNCT_KEYS[i].plain == ch) {
      *code = PUNCT_KEYS[i].code;
      return true;
    }
    if (PUNCT_KEYS[i].shifted == ch) {
      *code = PUNCT_KEYS[i].code;
      *shift = 1;
      return true;
    }
  }
  return false;
}

/* Resolve a symbol name ("Escape", "LEFTCTRL") or a single character ("a"). */
static bool resolve_key_name(const char *name, uint32_t *code, int *shift) {
  *shift = 0;
  if (name[0] != '\0' && name[1] == '\0') {
    return text_char_to_key((unsigned char)name[0], code, shift);
  }
  for (size_t i = 0; i < sizeof NAMED_KEYS / sizeof NAMED_KEYS[0]; i++) {
    if (strcmp(NAMED_KEYS[i].name, name) == 0) {
      *code = NAMED_KEYS[i].code;
      return true;
    }
  }
  return false;
}

#endif /* WLI_KEYS_H */

#!/usr/bin/env bash
# Sourced by install-web-production.sh. Only the current symlink is moved;
# releases themselves are kept for bounded rollback retention.
RS_SWITCHED=0
RS_WEB_ROOT=
RS_PREVIOUS_TARGET=

release_switch_init() {
  RS_WEB_ROOT="$(realpath -m -- "$1")"
  [[ "$RS_WEB_ROOT" = /* && -d "$RS_WEB_ROOT/releases" ]] || return 1
  RS_PREVIOUS_TARGET=
  if [[ -L "$RS_WEB_ROOT/current" ]]; then
    RS_PREVIOUS_TARGET="$(readlink -f -- "$RS_WEB_ROOT/current")"
    [[ "$RS_PREVIOUS_TARGET" == "$RS_WEB_ROOT/releases/"* && -d "$RS_PREVIOUS_TARGET" ]] || return 1
  elif [[ -e "$RS_WEB_ROOT/current" ]]; then
    echo 'Current Web release must be a symlink.' >&2
    return 1
  fi
  RS_SWITCHED=0
}

release_switch_link() {
  local target
  target="$(realpath -e -- "$1")" || return 1
  [[ "$target" == "$RS_WEB_ROOT/releases/"* && -d "$target" ]] || {
    echo 'Release target is outside the expected releases directory.' >&2
    return 1
  }
  local next="$RS_WEB_ROOT/.current-next-$$"
  ln -s -- "$target" "$next"
  mv -Tf -- "$next" "$RS_WEB_ROOT/current"
}

release_switch_activate() {
  release_switch_link "$1" || return 1
  RS_SWITCHED=1
}

release_switch_rollback() {
  [[ "$RS_SWITCHED" == 1 ]] || return 0
  if [[ -n "$RS_PREVIOUS_TARGET" ]]; then
    release_switch_link "$RS_PREVIOUS_TARGET" || return 1
  else
    [[ -L "$RS_WEB_ROOT/current" ]] && rm -- "$RS_WEB_ROOT/current"
  fi
  RS_SWITCHED=0
}

release_switch_restore_with_config() {
  local previous_conf="$1" active_conf="$2" had_previous="$3"
  release_switch_rollback || return 1
  if [[ "$had_previous" == 1 ]]; then
    install -m 0644 -- "$previous_conf" "$active_conf"
  else
    rm -f -- "$active_conf"
  fi
}

release_switch_commit() { RS_SWITCHED=0; }

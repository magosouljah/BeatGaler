'use strict';

const path = require('node:path');
const { normalizeEmail } = require('./auth-helpers');

const virtualFiles = new WeakMap();
const userIdKey = user => String(user?.id || '');
const userEmailKey = user => normalizeEmail(user?.email);

function indexUsers(users, keyFor) {
  const index = new Map();
  try {
    for (const user of users) {
      const key = keyFor(user);
      // The legacy find returns the first matching entry, even for duplicate keys.
      if (!index.has(key)) index.set(key, user);
    }
    return index;
  } catch {
    // Retain the lazy lookup for legacy records whose fields cannot be coerced.
    return null;
  }
}

class IdentitySnapshot {
  #value;
  #sessions;
  #usersById;
  #usersByEmail;

  constructor(value) {
    this.#value = structuredClone({
      users: Array.isArray(value?.users) ? value.users : [],
      sessions: value?.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
        ? value.sessions
        : {},
    });
    this.#sessions = new Map(Object.entries(this.#value.sessions));
    this.#usersById = indexUsers(this.#value.users, userIdKey);
    this.#usersByEmail = indexUsers(this.#value.users, userEmailKey);
  }

  copy() {
    return structuredClone(this.#value);
  }

  // M7.4f: copia, en orden, solo los usuarios cuya clave de id (`String(user?.id || '')`) acepta `keep`.
  // `keep` recibe la cadena, nunca el registro, así que no puede mutar el índice.
  copyUsersWhere(keep) {
    const picked = [];
    for (const user of this.#value.users) if (keep(userIdKey(user))) picked.push(user);
    return structuredClone(picked);
  }

  session(hash) {
    return structuredClone(this.#sessions.get(hash));
  }

  userById(id) {
    const user = this.#usersById && typeof id === 'string'
      ? this.#usersById.get(id)
      : this.#value.users.find(entry => userIdKey(entry) === String(id));
    return structuredClone(user || null);
  }

  userByEmail(email) {
    const key = normalizeEmail(email);
    const user = this.#usersByEmail
      ? this.#usersByEmail.get(key)
      : this.#value.users.find(entry => userEmailKey(entry) === key);
    return structuredClone(user || null);
  }
}

function installVirtualIdentity(fsModule, file, initialRaw, isShadowed) {
  let files = virtualFiles.get(fsModule);
  if (!files) {
    files = new Map();
    virtualFiles.set(fsModule, files);
  }
  const previous = files.get(file);
  let current = new IdentitySnapshot(initialRaw == null ? null : JSON.parse(initialRaw));
  // A direct write to the final virtual path shadows the committed bytes in the legacy bridge.
  const read = () => isShadowed() ? null : current;
  files.set(file, read);
  return {
    commit(value) { current = new IdentitySnapshot(value); },
    uninstall() {
      if (previous) files.set(file, previous);
      else files.delete(file);
    },
  };
}

function virtualIdentity(fsModule, file) {
  return virtualFiles.get(fsModule)?.get(path.resolve(file))?.();
}

module.exports = { IdentitySnapshot, installVirtualIdentity, virtualIdentity };

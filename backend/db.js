import { JSONFilePreset } from "lowdb/node";

const defaultData = { users: [], files: [], folders: [] };
const db = await JSONFilePreset("tgdrive.json", defaultData);

function now() { return Date.now(); }

export const Users = {
  findByPhone(phone) { return db.data.users.find((u) => u.phone === phone); },
  findById(id) { return db.data.users.find((u) => u.id === id); },
  all() { return db.data.users; },
  async upsert({ id, phone, encrypted_session }) {
    let user = this.findByPhone(phone);
    if (user) {
      user.encrypted_session = encrypted_session;
      user.last_login = now();
    } else {
      user = { id, phone, encrypted_session, created_at: now(), last_login: now(), last_active: now() };
      db.data.users.push(user);
    }
    await db.write();
    return user;
  },
  async touchActive(id) {
    const user = this.findById(id);
    if (user) { user.last_active = now(); await db.write(); }
  },
};

export const Folders = {
  findById(id) { return db.data.folders.find((f) => f.id === id); },
  findByUser(userId, parentId) {
    return db.data.folders
      .filter((f) => f.user_id === userId && (f.parent_id || null) === (parentId || null))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  findByUserAndParentAndName(userId, parentId, name) {
    return db.data.folders.find(
      (f) => f.user_id === userId && (f.parent_id || null) === (parentId || null) && f.name === name
    );
  },
  async create({ id, user_id, name, parent_id }) {
    const record = { id, user_id, name, parent_id: parent_id || null, created_at: now() };
    db.data.folders.push(record);
    await db.write();
    return record;
  },
  async getOrCreatePath(userId, parentId, name) {
    let existing = this.findByUserAndParentAndName(userId, parentId, name);
    if (existing) return existing;
    const { v4: uuidv4 } = await import("uuid");
    return this.create({ id: uuidv4(), user_id: userId, name, parent_id: parentId });
  },
  breadcrumb(folderId) {
    const trail = [];
    let current = folderId ? this.findById(folderId) : null;
    while (current) {
      trail.unshift(current);
      current = current.parent_id ? this.findById(current.parent_id) : null;
    }
    return trail;
  },
  async remove(id) {
    const idx = db.data.folders.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    db.data.folders.splice(idx, 1);
    await db.write();
    return true;
  },
};

export const Files = {
  async create(file) {
    const record = { visibility: "private", share_token: null, folder_id: null, created_at: now(), ...file };
    db.data.files.push(record);
    await db.write();
    return record;
  },
  findById(id) { return db.data.files.find((f) => f.id === id); },
  findByIdAndUser(id, userId) { return db.data.files.find((f) => f.id === id && f.user_id === userId); },
  findByUser(userId) {
    return db.data.files.filter((f) => f.user_id === userId).sort((a, b) => b.created_at - a.created_at);
  },
  findByUserAndFolder(userId, folderId) {
    return db.data.files
      .filter((f) => f.user_id === userId && (f.folder_id || null) === (folderId || null))
      .sort((a, b) => b.created_at - a.created_at);
  },
  findByShareToken(token) {
    return db.data.files.find((f) => f.share_token === token && f.visibility === "public");
  },
  all() { return db.data.files; },
  async update(id, changes) {
    const file = this.findById(id);
    if (!file) return null;
    Object.assign(file, changes);
    await db.write();
    return file;
  },
  async remove(id) {
    const idx = db.data.files.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    db.data.files.splice(idx, 1);
    await db.write();
    return true;
  },
};

export default db;

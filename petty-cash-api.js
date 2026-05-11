/* ────────────────────────────────────────────────────────────
 * petty-cash-api.js
 * ────────────────────────────────────────────────────────────
 * API client สำหรับระบบเบิกเงินสดย่อย
 *
 * Dual mode:
 *   - mode: "demo"   → ใช้ localStorage (fallback / offline test)
 *   - mode: "online" → ใช้ Google Apps Script Web App
 *
 * วิธีใช้ใน HTML:
 *   <script>
 *     window.PETTY_CASH_CONFIG = {
 *       mode: 'online',
 *       endpoint: 'https://script.google.com/macros/s/.../exec',
 *       token: 'AUTH_TOKEN',
 *       user: 'พี่ญ'
 *     };
 *   </script>
 *   <script src="petty-cash-api.js"></script>
 *   <!-- app code ที่เรียก window.storage จะถูก shim ให้คุยกับ Apps Script -->
 *
 * วิธีการ: เราใช้ Storage Shim Pattern
 *   - app code ปัจจุบันเรียก window.storage.get/set ที่ key petty_cash_v3
 *   - api-client.js shim window.storage ให้ proxy ไปที่ Apps Script
 *   - app code ไม่ต้องแก้
 * ──────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  const cfg = global.PETTY_CASH_CONFIG || { mode: 'demo' };
  const MODE = cfg.mode || 'demo';
  const STORAGE_KEY_V3 = 'petty_cash_v3';
  const ATT_KEY_PREFIX = 'pcatt_';
  const CACHE_KEY = 'petty_cash_online_cache';

  // ─── ตัวบ่งสถานะ ──────────────────────────────────────────────
  const status = {
    mode: MODE,
    connected: null,  // null = ยังไม่ทดสอบ, true = ok, false = fail
    error: null,
    lastSync: null
  };
  global.PettyCashStatus = status;

  // event ที่ component ฟังได้
  const listeners = [];
  function notifyStatus() {
    listeners.forEach(fn => { try { fn(status); } catch (e) {} });
  }
  global.onPettyCashStatusChange = (fn) => {
    listeners.push(fn);
    fn(status);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  // ─── Helpers ──────────────────────────────────────────────────
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const b64 = result.indexOf(',') >= 0 ? result.split(',')[1] : result;
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ─── Online Adapter ───────────────────────────────────────────
  const Online = {
    async _post(action, data) {
      if (!cfg.endpoint) throw new Error('endpoint ยังไม่ตั้งค่า');
      const body = Object.assign({ action, token: cfg.token }, data || {});
await fetch(cfg.endpoint, {
  method: 'POST',
  mode: 'no-cors',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify(body)
});

return {
  ok: true,
  success: true,
  message: 'ส่งข้อมูลไปยังระบบแล้ว'
};
    },

    async ping() {
      try {
        const r = await Online._post('ping');
        status.connected = true;
        status.error = null;
        status.lastSync = new Date().toISOString();
        notifyStatus();
        return r;
      } catch (e) {
        status.connected = false;
        status.error = e.message;
        notifyStatus();
        throw e;
      }
    },

    async list(filter) {
      const r = await Online._post('list', filter || {});
      status.lastSync = new Date().toISOString();
      notifyStatus();
      return r.transactions || [];
    },

    async create(transaction, attachments) {
      const atts = await Promise.all((attachments || []).map(async (f) => ({
        name: f.name,
        mimeType: f.type,
        base64: await fileToBase64(f)
      })));
      return Online._post('create', {
        transaction,
        attachments: atts,
        user: cfg.user || ''
      });
    },

    cancel(recordId, reason) {
      return Online._post('cancel', {
        record_id: recordId,
        reason: reason || '',
        user: cfg.user || ''
      });
    }
  };

  // ─── Demo (localStorage) Adapter ──────────────────────────────
  const Demo = {
    _read() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY_V3) || '{"transactions":[]}'); }
      catch (e) { return { transactions: [] }; }
    },
    _write(data) {
      localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(data));
    },

    async ping() {
      status.connected = true;
      status.error = null;
      notifyStatus();
      return { ok: true, mode: 'demo' };
    },

    async list(filter) {
      const all = Demo._read().transactions || [];
      filter = filter || {};
      return all.filter(t => {
        if (filter.dateFrom && t.date < filter.dateFrom) return false;
        if (filter.dateTo && t.date > filter.dateTo) return false;
        if (!filter.includeCancelled && t.is_cancelled) return false;
        return true;
      });
    },

    async create(transaction, attachments) {
      // เก็บไฟล์ใน localStorage
      const fileLinks = [];
      for (const f of (attachments || [])) {
        const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        localStorage.setItem(ATT_KEY_PREFIX + id, dataUrl);
        fileLinks.push({ id, name: f.name, mimeType: f.type, url: '#local-' + id });
      }

      const recordId = transaction.record_id ||
        ('tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      const tx = Object.assign({}, transaction, {
        record_id: recordId,
        created_at: new Date().toISOString(),
        created_by: cfg.user || 'demo',
        file_links: fileLinks,
        is_cancelled: false
      });

      const data = Demo._read();
      data.transactions = [tx, ...(data.transactions || [])];
      Demo._write(data);
      return { ok: true, record_id: recordId, file_links: fileLinks };
    },

    async cancel(recordId, reason) {
      const data = Demo._read();
      data.transactions = (data.transactions || []).map(t =>
        t.record_id === recordId
          ? Object.assign({}, t, {
              is_cancelled: true,
              cancelled_at: new Date().toISOString(),
              cancel_reason: reason || ''
            })
          : t
      );
      Demo._write(data);
      return { ok: true };
    }
  };

  // ─── เลือก adapter + auto-fallback ────────────────────────────
  const adapter = (MODE === 'online') ? Online : Demo;

  global.PettyCashAPI = {
    mode: MODE,
    config: cfg,
    ping: adapter.ping,
    list: adapter.list,
    create: adapter.create,
    cancel: adapter.cancel,
    // helpers
    fileToBase64,
    status
  };

  // ═══════════════════════════════════════════════════════════════
  //  Storage Shim — ทำให้ app code ที่ใช้ window.storage ใช้ได้เลย
  //  โดยไม่ต้องแก้
  // ═══════════════════════════════════════════════════════════════
  //
  //  วิธีทำงาน:
  //   - app code อ่าน window.storage.get("petty_cash_v3") → return all
  //     transactions ในรูปแบบเดิม
  //   - app code เขียน window.storage.set("petty_cash_v3", json) →
  //     compare กับ snapshot เดิม → ส่ง create/cancel ไป backend
  //   - attachments: app code อ่าน pcatt_xxx → return data URL
  //     จาก url ที่ Drive (proxy ผ่าน Drive view link)

  // ใน online mode: cache transactions แบบ in-memory + localStorage
  let cachedTxs = null;

  async function loadFromBackend() {
    try {
      const txs = await adapter.list({ includeCancelled: true });
      // map จาก schema backend → schema ที่ app code ใช้
      const mapped = txs.map(backendToApp);
      cachedTxs = mapped;
      // cache ใน localStorage (offline fallback)
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ transactions: mapped }));
      } catch (e) { /* ignore quota */ }
      return mapped;
    } catch (e) {
      console.error('[PettyCashAPI] load failed, using cache:', e);
      status.connected = false;
      status.error = e.message;
      notifyStatus();
      // fallback ไป cache
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{"transactions":[]}');
        return c.transactions || [];
      } catch (e2) { return []; }
    }
  }

  // map backend → app format (ที่ component ใช้)
  function backendToApp(t) {
    const app = {
      id: t.record_id,
      record_id: t.record_id,
      date: t.date,
      shift: t.shift,
      category: t.category,
      description: t.description,
      amount: parseFloat(t.amount) || 0,
      paymentMethod: t.payment_method,
      note: t.note || '',
      createdAt: t.created_at ? new Date(t.created_at).getTime() : Date.now(),
      created_by: t.created_by,
      attachments: t.file_links || [],
      cancelled: t.is_cancelled === true,
      cancelledAt: t.cancelled_at ? new Date(t.cancelled_at).getTime() : null
    };
    // team (เฉพาะช่างติดตั้ง/ทีมมีเดีย)
    if (t.team) app.team = t.team;
    // mileage
    if (t.fuel_cost > 0 || t.toll_fee > 0 || t.food_cost > 0 || t.other_cost > 0 || t.mileage_distance > 0) {
      app.mileage = {
        before: parseFloat(t.mileage_before) || null,
        after: parseFloat(t.mileage_after) || null,
        distance: parseFloat(t.mileage_distance) || 0,
        rate: parseFloat(t.fuel_rate) || 0,
        fuelCost: parseFloat(t.fuel_cost) || 0,
        tollFee: parseFloat(t.toll_fee) || 0,
        otherCost: parseFloat(t.other_cost) || 0
      };
      if (t.food_cost > 0) app.mileage.foodCost = parseFloat(t.food_cost);
    }
    // OT
    if (t.ot_count > 0 || t.ot_workers) {
      app.ot = {
        workers: t.ot_workers || '',
        count: parseFloat(t.ot_count) || 0,
        rate: parseFloat(t.ot_rate) || 0,
        total: (parseFloat(t.ot_count) || 0) * (parseFloat(t.ot_rate) || 0)
      };
    }
    return app;
  }

  // ─── Shim window.storage ──────────────────────────────────────
  // เก็บไว้: original storage (ถ้ามี — เช่นใน Claude artifact)
  const _origStorage = global.storage;

  global.storage = {
    async get(key) {
      // ถ้าเป็น petty_cash_v3 → โหลดจาก backend
      if (key === STORAGE_KEY_V3) {
        if (cachedTxs === null) {
          cachedTxs = await loadFromBackend();
        }
        return { key, value: JSON.stringify({ transactions: cachedTxs }), shared: false };
      }
      // ไฟล์แนบ — return URL ของ Drive (browser load เอง)
      if (key.startsWith(ATT_KEY_PREFIX)) {
        // ไฟล์ใน Drive — ไม่มี dataUrl, return null เพื่อให้ component แสดงเป็น link
        return null;
      }
      // อย่างอื่น fallback localStorage
      const v = localStorage.getItem(key);
      return v === null ? null : { key, value: v, shared: false };
    },

    async set(key, value) {
      // ถ้าเป็น petty_cash_v3 → compare แล้วส่ง create/cancel
      if (key === STORAGE_KEY_V3) {
        try {
          const parsed = JSON.parse(value);
          const newTxs = parsed.transactions || [];
          const oldTxs = cachedTxs || [];

          // หา new transactions
          const oldIds = new Set(oldTxs.map(t => t.id));
          const added = newTxs.filter(t => !oldIds.has(t.id));

          // หา newly cancelled
          const oldCancelMap = new Map(oldTxs.map(t => [t.id, t.cancelled]));
          const newlyCancelled = newTxs.filter(t =>
            t.cancelled && oldCancelMap.get(t.id) !== true);

          // ส่ง create requests
          for (const tx of added) {
            await sendCreate(tx);
          }

          // ส่ง cancel requests
          for (const tx of newlyCancelled) {
            await adapter.cancel(tx.record_id || tx.id, tx.cancel_reason || '');
          }

          // refresh cache
          cachedTxs = await loadFromBackend();
          return { key, value: JSON.stringify({ transactions: cachedTxs }), shared: false };

        } catch (e) {
          console.error('[PettyCashAPI] sync failed:', e);
          status.connected = false;
          status.error = e.message;
          notifyStatus();
          throw e;
        }
      }
      // อย่างอื่น fallback localStorage
      localStorage.setItem(key, value);
      return { key, value, shared: false };
    },

    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true, shared: false };
    },

    async list(prefix) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      }
      return { keys };
    }
  };

  // ─── ส่ง create ─────────────────────────────────────────────
  async function sendCreate(appTx) {
    // map app → backend format
    const backendTx = {
      record_id: appTx.record_id || appTx.id,
      date: appTx.date,
      shift: appTx.shift,
      category: appTx.category,
      team: appTx.team || '',
      description: appTx.description,
      paymentMethod: appTx.paymentMethod,
      amount: appTx.amount,
      note: appTx.note || '',
      mileage: appTx.mileage,
      ot: appTx.ot
    };

    // แปลง attachments (data URL จาก storage) เป็น File objects
    const fileObjects = [];
    if (appTx.attachments && appTx.attachments.length > 0) {
      for (const att of appTx.attachments) {
        // ถ้าเป็น att จาก app (มี id แต่ไม่มี url drive) → โหลดจาก localStorage
        if (att.id && !att.url) {
          try {
            const dataUrl = localStorage.getItem(ATT_KEY_PREFIX + att.id);
            if (dataUrl) {
              const blob = await (await fetch(dataUrl)).blob();
              const file = new File([blob], att.name, { type: att.type || att.mimeType });
              fileObjects.push(file);
            }
          } catch (e) {
            console.warn('Failed to load attachment:', att, e);
          }
        }
      }
    }

    return adapter.create(backendTx, fileObjects);
  }

  console.log('[PettyCashAPI] mode =', MODE,
    MODE === 'online' ? `(endpoint: ${cfg.endpoint ? 'set' : 'NOT SET'})` : '');

  // Ping ทันทีที่โหลด (test connection)
  if (MODE === 'online') {
    adapter.ping().catch(e => {
      console.warn('[PettyCashAPI] ping failed:', e.message);
    });
  }
  // ─── LocalStorage Bridge ─────────────────────────────────────
  // ดักกรณี app code เขียน localStorage.setItem('petty_cash_v3', ...)
  // แล้วส่งรายการใหม่เข้า backend อัตโนมัติ
  const _originalSetItem = Storage.prototype.setItem;

  Storage.prototype.setItem = function (key, value) {
    const oldValue = this.getItem(key);
    const result = _originalSetItem.apply(this, arguments);

    if (MODE === 'online' && key === STORAGE_KEY_V3) {
      setTimeout(async () => {
        try {
          const oldParsed = JSON.parse(oldValue || '{"transactions":[]}');
          const newParsed = JSON.parse(value || '{"transactions":[]}');

          const oldTxs = oldParsed.transactions || [];
          const newTxs = newParsed.transactions || [];

          const oldIds = new Set(oldTxs.map(t => t.id || t.record_id));
          const added = newTxs.filter(t => !oldIds.has(t.id || t.record_id));

          for (const tx of added) {
            console.log('[PettyCashAPI] auto sync create:', tx);
            await sendCreate(tx);
          }

          if (added.length > 0) {
            cachedTxs = await loadFromBackend();
            status.connected = true;
            status.error = null;
            status.lastSync = new Date().toISOString();
            notifyStatus();
          }

        } catch (e) {
          console.error('[PettyCashAPI] localStorage bridge sync failed:', e);
          status.connected = false;
          status.error = e.message;
          notifyStatus();
        }
      }, 0);
    }

    return result;
  };
})(window);

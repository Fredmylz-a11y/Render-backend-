const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const crypto = require('crypto');
const nodeFetch = require('node-fetch');

const BUILD_ID = 'rhinoverse-rental-earnings-reconcile-2026-11-21-v1';
const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Admin-Secret','X-MarzPay-Timestamp','X-MarzPay-Signature'] }));
app.use(express.json());
app.disable('etag');
app.use((req,res,next)=>{res.set('Cache-Control','no-store'); next();});

// Render process health check; independent of Firebase/provider configuration.
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok', service: 'rhinoverse-backend', build: BUILD_ID }));

// Reports the outbound IP used by this Render instance for this request.
// Render Free uses shared/rotating egress, so this is diagnostic only.
app.get('/my-ip', async (_req, res) => {
  try {
    const r = await nodeFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`IP lookup failed (${r.status})`);
    const data = await r.json();
    res.json({ ip: data.ip || null, proxy: false, note: 'This is Render direct egress, not the Node4 proxy IP.' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const JWT_SECRET = String(process.env.JWT_SECRET || '').trim();
const WELCOME_BONUS = 3000;
let db = null;
let firebaseInitError = null;
const requiredFirebaseEnv = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const missingFirebaseEnv = requiredFirebaseEnv.filter((key) => !process.env[key]);
if (!missingFirebaseEnv.length) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }) });
    }
    const { getFirestore } = require('firebase-admin/firestore');
    // Always use the intended named Firestore database, never (default).
    db = getFirestore(admin.app(), 'rhinoverse');
    console.log('Connected to Firestore database: rhinoverse');
  } catch (e) {
    firebaseInitError = e.message;
    console.error('Firebase initialization failed:', e.message);
  }
} else {
  firebaseInitError = `Missing environment variables: ${missingFirebaseEnv.join(', ')}`;
}

if (!db) {
  // Surface deployment configuration problems as JSON instead of crashing module startup.
  app.get('/', (_req, res) => res.status(503).json({ status: 'misconfigured', service: 'rhinoverse-backend' }));
  app.get('/api/health', (_req, res) => res.status(503).json({
    status: 'misconfigured', database: 'rhinoverse', error: firebaseInitError || 'Firestore initialization failed',
    missingEnvironment: missingFirebaseEnv,
  }));
} else {
  const usersCollection = db.collection('users');

const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
// Stable six-character invitation codes: uppercase letters + digits, never derived from usernames.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateUniqueReferralCode = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    let candidate = '';
    for (let i = 0; i < 6; i++) candidate += REFERRAL_ALPHABET[crypto.randomInt(0, REFERRAL_ALPHABET.length)];
    // findUser also checks legacyReferralCodes, preventing reuse of a retired invitation code.
    if (!(await findUser(candidate))) return candidate;
  }
  throw new Error('Could not generate a unique referral code. Please retry.');
};

const findUser = async (identifier) => {
  let snap = await usersCollection.where('username', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  snap = await usersCollection.where('phone', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  snap = await usersCollection.where('referralCode', '==', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  snap = await usersCollection.where('legacyReferralCodes', 'array-contains', identifier).limit(1).get();
  if (!snap.empty) return {...snap.docs[0].data(), _docId: snap.docs[0].id };
  return null;
};

const findUserById = async (id) => {
  const doc = await usersCollection.doc(id).get();
  if (!doc.exists) return null;
  return {...doc.data(), _docId: doc.id };
};

const authenticate = async (req, res, next) => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ error: "Backend authentication is not configured. Set a strong JWT_SECRET (at least 32 characters) in your Render backend service Environment settings." });
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please log in again.' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Your session has expired. Please log in again.' }); }
};

const PRODUCTS = [
  { id: 1, name: 'Rhino Calf', price: 20000, dailyIncome: 5000, cycleDays: 60, totalIncome: 300000, image: 'https://i.ibb.co/0jmmrzr1/IMG-20260829-WA5424.jpg' },
  { id: 2, name: 'Rhino Skin', price: 50000, dailyIncome: 12000, cycleDays: 60, totalIncome: 720000, image: 'https://i.ibb.co/1YG6y5Mr/IMG-20260829-WA1031.jpg' },
  { id: 3, name: 'Rhino Horn', price: 100000, dailyIncome: 25000, cycleDays: 60, totalIncome: 1500000, image: 'https://i.ibb.co/YFqPJ1Rx/IMG-20260829-WA6326.jpg' },
  { id: 4, name: 'Rhino Vision', price: 200000, dailyIncome: 50000, cycleDays: 60, totalIncome: 3000000, image: 'https://i.ibb.co/prbgjg9M/IMG-20260829-WA1518.jpg' },
  { id: 5, name: 'Rhino Charge', price: 500000, dailyIncome: 90000, cycleDays: 60, totalIncome: 5400000, image: 'https://i.ibb.co/fYBx2dWd/IMG-20260829-WA7423.jpg' },
  { id: 6, name: 'Rhino King', price: 1000000, dailyIncome: 150000, cycleDays: 60, totalIncome: 9000000, image: 'https://i.ibb.co/wN99z7HR/IMG-20260829-WA8772.jpg' },
  { id: 7, name: 'Rhino Legacy', price: 2000000, dailyIncome: 300000, cycleDays: 60, totalIncome: 18000000, image: 'https://i.ibb.co/DDzyP2R5/IMG-20261123-WA7272.jpg' },
];

// Referral commission rates shown on the Team page. Applied once per successful deposit.
const COMMISSION_RATES = { 1: 0.30, 2: 0.02, 3: 0.01 };

app.get('/api/health', async (req, res) => {
  try {
    await usersCollection.limit(1).get();
    res.json({ status: 'healthy', db: 'rhinoverse', build: BUILD_ID, project: process.env.FIREBASE_PROJECT_ID, authenticationConfigured: Boolean(JWT_SECRET && JWT_SECRET.length >= 32), marzPayConfigured: marzPayConfigured(), marzPayBase: MARZPAY_API_BASE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/', (req, res) => res.json({ status: 'Running', db: 'rhinoverse', full: true }));
app.get('/api/products', (req, res) => res.json(PRODUCTS));

// COMPATIBILITY ROUTES FOR FRONTEND m-nu.vercel.app
app.get('/api/products/my', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const products = await getUserRentalProducts(req.user.id, user);
    res.json({ products, data: products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wallet/balance', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      recharge: user.wallets?.recharge || 0,
      withdrawal: user.wallets?.withdrawal || 0,
      rechargeWallet: user.wallets?.recharge || 0,
      withdrawalWallet: user.wallets?.withdrawal || 0,
      balance: user.wallets?.recharge || 0,
      data: user.wallets,
      wallets: user.wallets
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wallet', authenticate, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    res.json(user.wallets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ error: "Backend authentication is not configured. Set a strong JWT_SECRET in your Render backend service Environment settings." });
  try {
    const { username, phone, password } = req.body;
    let { referrer } = req.body;
    if (!username || !phone || !password) return res.status(400).json({ error: 'Missing fields' });
    if (await findUser(username)) return res.status(400).json({ error: 'Username taken' });
    if (await findUser(phone)) return res.status(400).json({ error: 'Phone exists' });
    let referrerUser = null;
    if (typeof referrer === 'string') referrer = referrer.trim();
    if (referrer) {
      referrerUser = await findUser(referrer);
      if (!referrerUser) return res.status(400).json({ error: 'Referral code not found. Check the invitation code and try again.' });
      if (referrerUser.phone === phone || referrerUser.username?.toLowerCase() === username.toLowerCase()) return res.status(400).json({ error: 'You cannot refer yourself.' });
      referrer = referrerUser.referralCode || referrerUser.username;
    } else {
      referrer = null;
    }
    const hashed = await bcrypt.hash(password, 10);
    const userId = generateId();
    // Generate a unique, stable six-character alphanumeric invitation code.
    const referralCode = await generateUniqueReferralCode();
    const newUser = {
      id: userId, username, phone, password: hashed, referralCode,
      referrer, upline: referrer,
      registered: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      rechargeBalance: 0, earningsBalance: WELCOME_BONUS,
      wallets: { recharge: 0, withdrawal: WELCOME_BONUS },
      products: [], commissions: {1:0,2:0,3:0}, totalEarnings: 0,
      downlines: [], level1: [], level2: [], level3: [],
      lastCheckin: null, checkinStreak: 0
    };
    if (referrer) {
      const r = await findUser(referrer);
      if (r) {
        const rId = r._docId || r.id;
        const rData = await findUserById(rId) || r;
        await usersCollection.doc(rId).update({
          level1: [...(rData.level1||[]), username],
          downlines: [...(rData.downlines||[]), username]
        });
        if (rData.upline) {
          const u2 = await findUser(rData.upline);
          if (u2) {
            const u2Id = u2._docId || u2.id;
            await usersCollection.doc(u2Id).update({ level2: [...(u2.level2||[]), username] });
            if (u2.upline) {
              const u3 = await findUser(u2.upline);
              if (u3) {
                const u3Id = u3._docId || u3.id;
                await usersCollection.doc(u3Id).update({ level3: [...(u3.level3||[]), username] });
              }
            }
          }
        }
      }
    }
    await usersCollection.doc(userId).set(newUser);
    await transactionsCollection.doc(`welcome_${userId}`).set({userId,type:'welcome_bonus',amount:WELCOME_BONUS,status:'success',currency:'UGX',createdAt:new Date().toISOString(),reference:`WELCOME_${userId}`});
    const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Registration successful', token, user: { id: userId, username, phone, referralCode, wallets: newUser.wallets } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  if (!JWT_SECRET || JWT_SECRET.length < 32) return res.status(503).json({ error: "Backend authentication is not configured. Set a strong JWT_SECRET in your Render backend service Environment settings." });
  try {
    const { phone, password } = req.body;
    const user = await findUser(phone);
    if (!user) return res.status(400).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, message: 'Login successful', user: { id: user.id, username: user.username, phone: user.phone, referralCode: user.referralCode || null, wallets: user.wallets } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user', authenticate, async (req, res) => {
  const doc = await usersCollection.doc(req.user.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Not found' });
  const u = doc.data(); delete u.password; res.json(u);
});

app.post('/api/buy', authenticate, async (req, res) => {
  try {
    const product = PRODUCTS.find(p => p.id === Number(req.body?.productId));
    if (!product) return res.status(400).json({ error: 'Invalid product' });
    const userRef = usersCollection.doc(req.user.id), rentalRef = rentalsCollection.doc(), txRef = transactionsCollection.doc();
    const now = new Date(), expiry = new Date(now.getTime() + product.cycleDays * 86400000);
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('User not found');
      const user = snap.data(), recharge = amountOf(user, 'rechargeBalance'), withdrawal = amountOf(user, 'earningsBalance');
      if (recharge < product.price) throw new Error('Insufficient recharge balance');
      const purchased = { ...product, purchaseDate: now.toISOString(), expiryDate: expiry.toISOString(), rentedAt: admin.firestore.Timestamp.fromDate(now), expiresAt: admin.firestore.Timestamp.fromDate(expiry), earned: 0, active: true, rentalId: rentalRef.id, rentalStatus: 'active' };
      tx.update(userRef, { ...setWallets(user, recharge - product.price, withdrawal), products: [...(user.products || []), purchased], hasPurchasedProduct: true, updatedAt: SERVER_TIME() });
      tx.set(rentalRef, { userId: req.user.id, productId: product.id, name: product.name, price: product.price, dailyIncome: product.dailyIncome, duration: product.cycleDays, status: 'active', rentedAt: admin.firestore.Timestamp.fromDate(now), expiresAt: admin.firestore.Timestamp.fromDate(expiry), lastPayoutDate: null, nextPayoutAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 86400000)), createdAt: SERVER_TIME() });
      tx.set(txRef, { userId: req.user.id, type: 'rent', amount: -product.price, productId: product.id, status: 'success', createdAt: SERVER_TIME() });
      return purchased;
    });
    res.json({ message: 'Product purchased; daily income is now active.', product: result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/checkin', authenticate, async (req, res) => {
  try {
    const userRef = usersCollection.doc(req.user.id);
    const now = new Date();
    const CHECKIN_REWARD = 100;
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('User not found');
      const user = snap.data();
      const last = user.lastCheckin ? new Date(user.lastCheckin) : null;
      const elapsed = last ? now.getTime() - last.getTime() : Infinity;
      if (elapsed < 24 * 60 * 60 * 1000) {
        const remainingMs = 24 * 60 * 60 * 1000 - elapsed;
        const remainingHours = Math.floor(remainingMs / 3600000);
        const remainingMinutes = Math.ceil((remainingMs % 3600000) / 60000);
        throw new Error(`You have already checked in. Try again in ${remainingHours}h ${remainingMinutes}m.`);
      }
      // Product/rental income is credited only by /api/cron/daily-earnings.
      // Check-in must never pay it again, otherwise users can double-earn.
      const earned = CHECKIN_REWARD;
      const recharge = amountOf(user, 'rechargeBalance');
      const withdrawal = amountOf(user, 'earningsBalance') + earned;
      const txRef = transactionsCollection.doc(`checkin_${req.user.id}_${now.getTime()}`);
      tx.update(userRef, {
        ...setWallets(user, recharge, withdrawal),
        lastCheckin: now.toISOString(), totalEarnings: Number(user.totalEarnings || 0) + earned,
        updatedAt: SERVER_TIME()
      });
      tx.create(txRef, { userId: req.user.id, type: 'daily_checkin', amount: CHECKIN_REWARD, status: 'success', currency: 'UGX', createdAt: SERVER_TIME(), reference: `CHECKIN_${req.user.id}_${now.toISOString()}` });
      return { earned, productIncome: 0, wallets: { ...(user.wallets || {}), recharge, withdrawal } };
    });
    res.json({ message: 'Check-in successful! You received 100 UGX. Product income is credited separately by the daily earnings service.', earned: result.earned, checkinReward: CHECKIN_REWARD, productIncome: 0, wallets: result.wallets });
  } catch (e) {
    const alreadyChecked = String(e.message || '').includes('already checked in');
    res.status(alreadyChecked ? 400 : 500).json({ error: e.message || 'Check-in failed.' });
  }
});


// User account, history and support APIs. Payment-provider actions fail closed until credentials/API URL are configured.
// MARZ Pay settings follow the uploaded Merchant API Integration Guide.
// Uses the configured MarzPay API base; default matches https://wallet.marzpay.com/api/collect-money.
const MARZPAY_API_BASE = 'https://wallet.wearemarz.com/api/v1';
console.log('[RHINOVERSE BUILD]', BUILD_ID, 'MarzPay base:', MARZPAY_API_BASE, 'proxy: disabled');
const marzPayConfigured = () => Boolean(process.env.MARZPAY_API_KEY && process.env.MARZPAY_API_SECRET);
const transactionsCollection = db.collection('transactions');
const ticketsCollection = db.collection('supportTickets');
const bonusCodesCollection = db.collection('bonusCodes');
const withdrawalsCollection = db.collection('withdrawals');
const SERVER_TIME = admin.firestore.FieldValue.serverTimestamp;
const amountOf = (u, key) => { const nested = key === 'rechargeBalance' ? u.wallets?.recharge : u.wallets?.withdrawal; return Number(nested ?? u[key] ?? 0); };
const setWallets = (u, recharge, earnings) => ({
  rechargeBalance: recharge, earningsBalance: earnings,
  wallets: { ...(u.wallets || {}), recharge, withdrawal: earnings }
});
const ugPhoneE164 = (value) => {
  let digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('256')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^7\d{8}$/.test(digits)) throw new Error('Enter a valid Uganda MTN/Airtel number, e.g. 07XXXXXXXX.');
  return `+256${digits}`;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// MarzPay requests intentionally use Render's direct outbound connection.
// NODE4_PROXY_URL is not read or used anywhere in this payment path.
const marzPayRequest = async (path, method = 'GET', payload, options = {}) => {
  if (!marzPayConfigured()) throw new Error('MARZ Pay credentials are missing. Configure MARZPAY_API_KEY and MARZPAY_API_SECRET in Render.');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const auth = Buffer.from(`${process.env.MARZPAY_API_KEY}:${process.env.MARZPAY_API_SECRET}`).toString('base64');
  const upperMethod = String(method || 'GET').toUpperCase();
  const url = `${MARZPAY_API_BASE}${normalizedPath}`;
  // Hard guard: MarzPay's /send-money endpoint must never receive metadata.
  // Strip it here at the final transport boundary, even if a caller accidentally adds it.
  let outboundPayload = payload;
  if (upperMethod === 'POST' && normalizedPath.replace(/\/$/, '') === '/send-money' && payload && typeof payload === 'object') {
    outboundPayload = { ...payload };
    delete outboundPayload.metadata;
    console.log('[MARZPAY WITHDRAWAL REQUEST]', { build: BUILD_ID, url, payloadKeys: Object.keys(outboundPayload), metadataIncluded: Object.prototype.hasOwnProperty.call(outboundPayload, 'metadata'), proxyUsed: false });
  }
  // Never retry money-moving POST requests after a timeout: MarzPay may have
  // accepted the first request even if Render did not receive its response.
  const maxAttempts = upperMethod === 'GET' ? 2 : 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await nodeFetch(url, {
        method: upperMethod,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: outboundPayload && upperMethod !== 'GET' ? JSON.stringify(outboundPayload) : undefined,
        // 70 seconds for slower mobile-money provider responses; no proxy agent.
        signal: AbortSignal.timeout(70000),
      });

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const raw = await response.text();
      let data = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (_) {
          const isHtml = contentType.includes('text/html') || /^\s*<!doctype html|^\s*<html/i.test(raw);
          const message = isHtml
            ? `MarzPay endpoint returned an HTML page instead of JSON (HTTP ${response.status}). Check the API host, network path, and provider allowlist.`
            : `MarzPay returned a non-JSON response (HTTP ${response.status}): ${raw.slice(0, 240)}`;
          const error = new Error(message);
          error.status = response.status;
          error.providerResponse = { contentType: contentType || null, bodyPreview: raw.slice(0, 240) };
          throw error;
        }
      }

      if (!response.ok || data.status === 'error') {
        const error = new Error(data.message || data.error || `MARZ Pay request failed (${response.status})`);
        error.status = response.status;
        error.providerResponse = data;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      // A real HTTP response is not a transient transport failure; do not retry it.
      const retryableTransportFailure = !Number.isInteger(error.status);
      if (!retryableTransportFailure || attempt >= maxAttempts) break;
      console.warn(`[MARZPAY] Direct ${upperMethod} transport attempt ${attempt}/${maxAttempts} failed; retrying in 2s:`, error.message);
      await sleep(2000);
    }
  }

  const finalError = lastError || new Error('MARZ Pay request failed without a response.');
  console.error('[MARZPAY] direct request failed:', {
    build: BUILD_ID,
    method: upperMethod,
    url,
    status: Number.isInteger(finalError.status) ? finalError.status : null,
    message: String(finalError.message || 'Unknown error').slice(0, 300),
    proxyUsed: false,
  });
  throw finalError;
};
const unwrapped = (payload) => payload?.data?.data || payload?.data || payload || {};
const transactionFrom = (payload) => {
  const root = unwrapped(payload);
  return root.transaction || payload?.transaction || {};
};
const statusFrom = (payload) => {
  const root = unwrapped(payload), tx = transactionFrom(payload);
  // The outer {status:'success'} often means the API request succeeded, not that money moved.
  // Do not treat a generic outer API response such as {status:'success'} as
  // proof that a mobile-money payout or collection actually completed.
  return String(tx.status || root.collection?.status || root.disbursement?.status || root.transfer?.status || root.withdrawal?.status || payload?.event_type || '').toLowerCase();
};
const rawAmountFrom = (payload) => {
  const root = unwrapped(payload), tx = transactionFrom(payload);
  const candidates = [tx.amount?.raw, tx.amount, root.collection?.amount?.raw, root.withdrawal?.amount?.raw, root.transfer?.amount?.raw];
  const found = candidates.find(v => v !== undefined && v !== null && v !== '');
  return Number(found);
};
const currencyFrom = (payload) => {
  const root = unwrapped(payload), tx = transactionFrom(payload);
  return String(tx.amount?.currency || root.collection?.amount?.currency || root.withdrawal?.amount?.currency || root.transfer?.amount?.currency || '').toUpperCase();
};
const successfulStatus = (status) => ['completed', 'successful', 'success', 'paid'].includes(String(status || '').toLowerCase().split('.').pop());
const failedStatus = (status) => ['failed', 'failure', 'cancelled', 'canceled', 'rejected'].includes(String(status || '').toLowerCase().split('.').pop());

async function settleRecharge(reference, providerStatusPayload) {
  const txRef = transactionsCollection.doc(reference);
  const txSnap = await txRef.get();
  if (!txSnap.exists) throw new Error('Recharge reference was not found.');
  const transaction = txSnap.data();
  const providerTx = transactionFrom(providerStatusPayload);
  const status = statusFrom(providerStatusPayload);
  const amount = rawAmountFrom(providerStatusPayload);
  const currency = currencyFrom(providerStatusPayload);
  if (providerTx.reference !== reference && providerTx.provider_reference !== reference) throw new Error('MARZ Pay reference does not match this recharge.');
  if (!Number.isFinite(amount) || amount !== Number(transaction.amount)) throw new Error('MARZ Pay amount could not be verified against this recharge.');
  if (currency !== 'UGX') throw new Error('MARZ Pay status did not confirm UGX currency; recharge was not credited.');
  if (successfulStatus(status)) {
    // Resolve up to three uplines before the Firestore transaction; all wallet credits and
    // the recharge's success marker are then committed atomically and are idempotent.
    const depositor = await findUserById(transaction.userId);
    const uplines = [];
    let nextReferrer = depositor?.referrer || depositor?.upline || null;
    for (let level = 1; level <= 3 && nextReferrer; level++) {
      const referrerUser = await findUser(nextReferrer);
      if (!referrerUser) break;
      const referrerId = referrerUser._docId || referrerUser.id;
      if (!referrerId || referrerId === transaction.userId || uplines.some(x => x.id === referrerId)) break;
      uplines.push({ id: referrerId, level, username: referrerUser.username || '' });
      nextReferrer = referrerUser.referrer || referrerUser.upline || null;
    }
    await db.runTransaction(async (tx) => {
      const currentTx = await tx.get(txRef);
      if (!currentTx.exists) throw new Error('Recharge reference was not found.');
      if (currentTx.data().status === 'success') return;
      const userRef = usersCollection.doc(transaction.userId);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found for this recharge.');
      const refSnaps = await Promise.all(uplines.map(x => tx.get(usersCollection.doc(x.id))));
      const u = userSnap.data();
      const newBalance = amountOf(u, 'rechargeBalance') + Number(transaction.amount);
      const earnings = amountOf(u, 'earningsBalance');
      tx.update(userRef, { ...setWallets(u, newBalance, earnings), updatedAt: SERVER_TIME() });
      for (let i = 0; i < uplines.length; i++) {
        if (!refSnaps[i].exists) continue;
        const recipient = refSnaps[i].data();
        const level = uplines[i].level;
        const commission = Math.floor(Number(transaction.amount) * COMMISSION_RATES[level]);
        if (commission <= 0) continue;
        const recipientRef = usersCollection.doc(uplines[i].id);
        const recipientEarnings = amountOf(recipient, 'earningsBalance');
        const commissions = { 1:0, 2:0, 3:0, ...(recipient.commissions || {}) };
        commissions[level] = Number(commissions[level] || 0) + commission;
        tx.update(recipientRef, {
          ...setWallets(recipient, amountOf(recipient,'rechargeBalance'), recipientEarnings + commission),
          commissions,
          totalTeamIncome: Number(recipient.totalTeamIncome || 0) + commission,
          totalCommission: Number(recipient.totalCommission || 0) + commission,
          updatedAt: SERVER_TIME()
        });
        tx.create(transactionsCollection.doc(`commission_${reference}_L${level}_${uplines[i].id}`), {
          userId: uplines[i].id, type:'referral_commission', amount:commission, level,
          sourceUserId:transaction.userId, sourceRechargeReference:reference, status:'success',
          currency:'UGX', createdAt:SERVER_TIME(), reference:`${reference}_L${level}`
        });
      }
      tx.update(txRef, { status: 'success', providerStatus: status, creditedAt: SERVER_TIME(), providerTransactionId: providerTx.uuid || null, updatedAt: SERVER_TIME() });
    });
    return { status: 'success', credited: true };
  }
  if (failedStatus(status)) {
    await db.runTransaction(async (tx) => {
      const current = await tx.get(txRef);
      if (!current.exists || current.data().status === 'success') return;
      tx.update(txRef, { status: 'failed', providerStatus: status, updatedAt: SERVER_TIME() });
    });
    const latest = await txRef.get();
    return { status: latest.data()?.status === 'success' ? 'success' : 'failed', credited: latest.data()?.status === 'success' };
  }
  await db.runTransaction(async (tx) => {
    const current = await tx.get(txRef);
    if (!current.exists || current.data().status === 'success') return;
    tx.update(txRef, { status: 'pending', providerStatus: status || 'processing', updatedAt: SERVER_TIME() });
  });
  const latest = await txRef.get();
  return { status: latest.data()?.status === 'success' ? 'success' : 'pending', credited: latest.data()?.status === 'success' };
}

async function getUserRentalProducts(userId, user) {
  const rentalsSnap = await rentalsCollection.where('userId', '==', userId).get();
  const rentalById = new Map(rentalsSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
  const now = new Date();
  return (Array.isArray(user.products) ? user.products : []).map((product) => {
    const rental = product.rentalId ? rentalById.get(product.rentalId) : null;
    const rawStart = rental?.rentedAt || product.rentedAt || product.purchaseDate || product.purchasedAt || product.createdAt;
    const rawExpiry = rental?.expiresAt || product.expiresAt || product.expiryDate;
    const asDate = value => value?.toDate ? value.toDate() : (value?._seconds ? new Date(value._seconds * 1000) : (value ? new Date(value) : null));
    const start = asDate(rawStart);
    const expiry = asDate(rawExpiry) || (start ? new Date(start.getTime() + Number(product.duration || product.cycleDays || 60) * 86400000) : null);
    // A real rental record is authoritative. For older records, a valid future expiry
    // proves the rental is still active even if the old user.products.active flag is false.
    const active = rental ? rental.status === 'active' && (!expiry || now < expiry) : (expiry ? now < expiry : product.active !== false);
    const dailyMs = 86400000;
    const nextIncomeAt = asDate(rental?.nextPayoutAt) || (start ? new Date(start.getTime() + dailyMs) : null);
    return {
      ...product,
      rentalId: product.rentalId || rental?.id || null,
      active,
      status: active ? 'active' : 'expired',
      rentalStatus: active ? 'active' : 'expired',
      rentedAt: start ? start.toISOString() : null,
      expiresAt: expiry ? expiry.toISOString() : null,
      nextIncomeAt: nextIncomeAt ? nextIncomeAt.toISOString() : null,
      dailyIncome: Number(rental?.dailyIncome || product.dailyIncome || product.productId?.dailyIncome || 0)
    };
  });
}

app.get('/api/investments/my-products', authenticate, async (req,res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const products = await getUserRentalProducts(req.user.id, user);
    res.json({ products, data: products });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/user/bind-account', authenticate, async (req,res) => {
  try {
    const bankName=String(req.body?.bankName||'').trim(), accountNumber=String(req.body?.accountNumber||'').trim(), holderName=String(req.body?.holderName||'').trim();
    if(!bankName||!accountNumber||!holderName) return res.status(400).json({error:'Bank name, account number and account holder name are required'});
    if(accountNumber.length<4||accountNumber.length>40) return res.status(400).json({error:'Invalid account number'});
    const account={id:crypto.randomUUID(),bankName,accountNumber,holderName,createdAt:new Date().toISOString()};
    await usersCollection.doc(req.user.id).update({boundAccount:account});
    res.json({message:'Account bound successfully',account:{...account,accountNumber:`••••${accountNumber.slice(-4)}`}});
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/bonus/redeem', authenticate, async (req,res) => {
  try {
    const code=String(req.body?.code||'').trim().toUpperCase();
    if(!code) return res.status(400).json({error:'Enter a bonus code'});
    const userRef=usersCollection.doc(req.user.id), codeRef=bonusCodesCollection.doc(code);
    const result=await db.runTransaction(async tx=>{
      const [u,c]=await Promise.all([tx.get(userRef),tx.get(codeRef)]);
      if(!u.exists) throw new Error('User not found');
      if(!c.exists||!c.data().active) throw new Error('Invalid or expired bonus code');
      const ud=u.data(), cd=c.data();
      if((ud.redeemedBonusCodes||[]).includes(code)) throw new Error('Bonus code already redeemed');
      const amount=Number(cd.amount); if(!Number.isFinite(amount)||amount<=0) throw new Error('Bonus code is not configured correctly');
      const earnings=amountOf(ud,'earningsBalance')+amount;
      tx.update(userRef,{...setWallets(ud,amountOf(ud,'rechargeBalance'),earnings),redeemedBonusCodes:[...(ud.redeemedBonusCodes||[]),code]});
      tx.create(transactionsCollection.doc(),{userId:req.user.id,type:'bonus',amount,status:'success',currency:'UGX',createdAt:new Date().toISOString(),reference:code});
      return amount;
    });
    res.json({message:'Bonus code redeemed successfully',credited:result});
  } catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/transactions/history', authenticate, async(req,res)=>{
  const startedAt = Date.now();
  res.set('Cache-Control', 'no-store, max-age=0');
  try {
    // Keep the query simple (single-field indexed filter) and cap the payload.
    // Do not add orderBy here: it can require a composite Firestore index.
    const snap=await transactionsCollection.where('userId','==',req.user.id).limit(500).get();
    const asIso=(value)=>value?.toDate?.()?.toISOString?.() || (value instanceof Date ? value.toISOString() : value);
    const rows=snap.docs.map(d=>{const row=d.data();return {id:d.id,...row,createdAt:asIso(row.createdAt),updatedAt:asIso(row.updatedAt),creditedAt:asIso(row.creditedAt)};}).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    console.log(`[CASH_RECORD] user=${req.user.id} rows=${rows.length} durationMs=${Date.now()-startedAt}`);
    res.json({transactions:rows,data:rows,count:rows.length});
  } catch(e){
    console.error(`[CASH_RECORD] user=${req.user.id} failed after ${Date.now()-startedAt}ms:`,e.message);
    res.status(503).json({error:'Cash Record is temporarily taking longer to load. Please retry; your balance and transactions have not been changed.'});
  }
});
app.post('/api/auth/change-password', authenticate, async(req,res)=>{
  try { const {oldPassword,newPassword}=req.body||{}; if(!oldPassword||typeof newPassword!=='string'||newPassword.length<6) return res.status(400).json({error:'Enter your current password and a new password of at least 6 characters'}); const ref=usersCollection.doc(req.user.id),snap=await ref.get(); if(!snap.exists)return res.status(404).json({error:'User not found'}); if(!await bcrypt.compare(oldPassword,snap.data().password))return res.status(400).json({error:'Current password is incorrect'}); await ref.update({password:await bcrypt.hash(newPassword,10)}); res.json({message:'Password changed successfully'}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/support/tickets', authenticate, async(req,res)=>{
  try { const snap=await ticketsCollection.where('userId','==',req.user.id).get(); const tickets=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))); res.json({tickets,data:tickets}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/support/tickets', authenticate, async(req,res)=>{
  try { const subject=String(req.body?.subject||'').trim(),message=String(req.body?.message||'').trim(); if(!subject||!message)return res.status(400).json({error:'Subject and message are required'}); const ticket={userId:req.user.id,subject:subject.slice(0,160),message:message.slice(0,5000),status:'open',createdAt:new Date().toISOString()}; const ref=await ticketsCollection.add(ticket); res.status(201).json({message:'Support ticket submitted',ticket:{id:ref.id,...ticket}}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/checkin/daily', authenticate, async(req,res,next)=>{req.url='/api/checkin';next();});

// Mobile money collections (Uganda MTN/Airtel are detected from the user's phone number).
async function initiateMarzRecharge(req, res) {
  let txRef=null;
  try {
    const amount=Number(req.body?.amount);
    if(!Number.isInteger(amount)||amount<500||amount>10000000) return res.status(400).json({error:'Recharge must be between 500 and 10,000,000 UGX.'});
    const user=await findUserById(req.user.id); if(!user) return res.status(404).json({error:'User not found'});
    const requestedPhone=req.body?.phone_number || req.body?.phone || user.phone;
    const phone=ugPhoneE164(requestedPhone), reference=crypto.randomUUID();
    const requestedNetwork=String(req.body?.network||'').trim().toUpperCase();
    if (requestedNetwork && !['MTN','AIRTEL'].includes(requestedNetwork)) return res.status(400).json({error:'Select MTN or Airtel.'});
    const callbackUrl=process.env.MARZPAY_CALLBACK_URL || process.env.MARZPAY_WEBHOOK_URL || (process.env.BACKEND_PUBLIC_URL ? `${process.env.BACKEND_PUBLIC_URL.replace(/\/$/,'')}/api/marzpay/webhook` : undefined);
    txRef=transactionsCollection.doc(reference);
    await txRef.create({userId:req.user.id,type:'recharge',amount,status:'creating',provider:'marzpay',reference,currency:'UGX',phoneNumber:phone,requestedNetwork:requestedNetwork||null,createdAt:new Date().toISOString()});
    // MARZ Pay detects MTN/Airtel from the E.164 phone number pattern. Explicitly set
    // mobile_money to avoid relying on a provider default; do not invent a network field
    // that is not part of the documented collection request schema.
    const provider=await marzPayRequest('/collect-money','POST',{
      amount,phone_number:phone,reference,country:'UG',method:'mobile_money',description:`Rhinoverse wallet recharge ${reference}`,
      ...(callbackUrl?{callback_url:callbackUrl}:{}),metadata:[{rhinoverseUserId:req.user.id},{rhinoverseTransactionReference:reference},{requestedNetwork:requestedNetwork||'UNSPECIFIED'}]
    });
    const root=unwrapped(provider),providerTx=transactionFrom(provider),providerUuid=providerTx.uuid||root.uuid||null;
    const providerStatus=String(providerTx.status||'processing').toLowerCase();
    await db.runTransaction(async tx=>{
      const current=await tx.get(txRef); if(!current.exists)return;
      const patch={providerUuid,providerStatus,providerName:root.collection?.provider||null,updatedAt:SERVER_TIME()};
      if(current.data().status!=='success') patch.status=failedStatus(providerStatus)?'failed':'pending';
      tx.update(txRef,patch);
    });
    const latest=await txRef.get();
    if(latest.data()?.status==='failed') return res.status(502).json({error:'MARZ Pay did not accept the recharge. No wallet credit was made.',reference});
    return res.status(202).json({message:'Recharge started. Approve the MTN or Airtel payment prompt on your phone.',reference,providerUuid,status:'pending',amount,currency:'UGX',phoneNumber:phone,provider:root.collection?.provider||'mobile money'});
  } catch(e) {
    // Log provider status and sanitized response details to diagnose MTN-only failures;
    // never log authorization headers or API credentials.
    console.error('[MARZPAY] recharge initiation failed:', JSON.stringify({status:e.status||null,message:e.message||'Unknown provider error',providerResponse:e.providerResponse||null}));
    const definitiveProviderRejection=Number.isInteger(e.status)&&e.status>=400&&e.status<500;
    if(txRef) await db.runTransaction(async tx=>{const current=await tx.get(txRef);if(current.exists&&current.data().status!=='success')tx.update(txRef,{status:definitiveProviderRejection?'failed':'provider_unknown',errorMessage:String(e.message||'Provider result is uncertain; reconcile before retrying').slice(0,300),updatedAt:SERVER_TIME()});}).catch(()=>{});
    const message=e.status===401?'MARZ Pay rejected its API credentials. Verify the active API key and secret with MARZ Pay.':e.status===403?'MARZ Pay denied the collection request. Confirm Uganda collections are enabled for this account.':e.message?.startsWith('Enter a valid Uganda')?e.message:definitiveProviderRejection?'MARZ Pay rejected the recharge request. Check the provider configuration.':'MARZ Pay did not return a definitive result. Check the recharge status before trying again.';
    return res.status(definitiveProviderRejection?400:202).json(definitiveProviderRejection?{error:message,...(txRef?{reference:txRef.id,status:'failed'}:{})}:{message:'MARZ Pay response is uncertain. Do not retry yet; check the recharge status.',reference:txRef?.id||null,status:'provider_unknown',error:message});
  }
}
app.post('/api/create-marz-payment', authenticate, initiateMarzRecharge);
app.post('/api/marzpay/recharge', authenticate, initiateMarzRecharge);

app.get('/api/marzpay/recharge/:reference', authenticate, async (req,res) => {
  try {
    const reference=String(req.params.reference||'');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)) return res.status(400).json({error:'Invalid recharge reference'});
    const txRef=transactionsCollection.doc(reference),snap=await txRef.get();
    if(!snap.exists||snap.data().userId!==req.user.id||snap.data().type!=='recharge') return res.status(404).json({error:'Recharge was not found'});
    if(['success','failed'].includes(snap.data().status)) return res.json({reference,status:snap.data().status,credited:snap.data().status==='success'});
    if(!snap.data().providerUuid) return res.json({reference,status:'pending',credited:false,message:'Waiting for MARZ Pay transaction reference.'});
    const provider=await marzPayRequest(`/collect-money/${encodeURIComponent(snap.data().providerUuid)}`);
    const state=await settleRecharge(reference,provider);
    res.json({reference,...state,message:state.status==='success'?'Recharge credited successfully.':state.status==='failed'?'MARZ Pay reported that the recharge failed.':'Payment is still processing.'});
  } catch(e) {
    console.error('[MARZPAY] status check failed:',e.message);
    res.status(502).json({error:'Could not verify the recharge status with MARZ Pay. The wallet was not credited.'});
  }
});

// Direct callbacks and registered dashboard webhooks are both accepted. Status is independently
// retrieved from MarzPay before the wallet is credited; duplicate callbacks are idempotent.
const handleMarzPayWebhook = async (req,res) => {
  try {
    const payload=req.body||{},root=payload.data&&typeof payload.data==='object'?payload.data:payload;
    const providerTx=root.transaction||payload.transaction||{};
    const eventType=String(payload.event_type||root.event_type||'').toLowerCase();
    const callbackUuid=String(providerTx.uuid||root.uuid||'');
    const metadata=Array.isArray(payload.metadata)?payload.metadata:(Array.isArray(root.metadata)?root.metadata:[]);
    const metadataObject=Object.assign({},...metadata.filter(x=>x&&typeof x==='object'));

    // MarzPay disbursement callbacks identify the Rhinoverse withdrawal in
    // metadata. Independently query MarzPay before releasing or refunding funds.
    if(eventType.startsWith('disbursement.') || metadataObject.withdrawalId) {
      let withdrawalId=String(metadataObject.withdrawalId||'');
      let withdrawalSnap=withdrawalId?await withdrawalsCollection.doc(withdrawalId).get():null;
      if(!withdrawalSnap?.exists && callbackUuid) {
        const match=await withdrawalsCollection.where('providerReference','==',callbackUuid).limit(1).get();
        if(!match.empty){withdrawalId=match.docs[0].id;withdrawalSnap=match.docs[0];}
      }
      if(!withdrawalSnap?.exists) return res.status(404).json({received:false,error:'Unknown withdrawal callback'});
      const w=withdrawalSnap.data();
      if(['paid','failed_refunded','rejected'].includes(w.status)) return res.status(200).json({received:true,status:w.status});
      const providerUuid=String(w.providerReference||callbackUuid);
      if(!providerUuid) return res.status(400).json({received:false,error:'Missing MARZ Pay disbursement UUID'});
      const verified=await marzPayRequest(`/send-money/${encodeURIComponent(providerUuid)}`, 'GET', undefined, {route:'withdrawal'});
      const state=statusFrom(verified);
      if(successfulStatus(state)) await updateWithdrawalTransaction(withdrawalId,'paid',providerUuid,{providerStatus:state,webhookConfirmed:true});
      else if(failedStatus(state)) {
        const providerMessage = String(verified.message || verified.data?.message || 'MARZ Pay confirmed that the disbursement failed.').slice(0,300);
        await updateWithdrawalTransaction(withdrawalId,'failed_refunded',providerUuid,{
          providerStatus:state,webhookConfirmed:true,providerError:providerMessage,failureReason:providerMessage
        });
      }
      else {
        await withdrawalsCollection.doc(withdrawalId).update({status:'provider_pending',providerStatus:state||'pending',updatedAt:SERVER_TIME()});
        const history=await transactionsCollection.where('withdrawalId','==',withdrawalId).limit(1).get();
        if(!history.empty) await history.docs[0].ref.update({status:'pending',providerStatus:state||'pending',updatedAt:SERVER_TIME()});
      }
      return res.status(200).json({received:true,status:successfulStatus(state)?'paid':failedStatus(state)?'failed_refunded':'pending'});
    }

    const reference=String(providerTx.reference||root.reference||providerTx.provider_reference||'');
    if(!reference||!callbackUuid) return res.status(400).json({error:'Missing MARZ Pay transaction reference or UUID'});
    const localRef=transactionsCollection.doc(reference),localSnap=await localRef.get();
    if(!localSnap.exists||localSnap.data().type!=='recharge') return res.status(404).json({error:'Unknown recharge reference'});
    if(localSnap.data().status==='success') return res.status(200).json({received:true,credited:true});
    const provider=await marzPayRequest(`/collect-money/${encodeURIComponent(localSnap.data().providerUuid||callbackUuid)}`);
    const state=await settleRecharge(reference,provider);
    return res.status(200).json({received:true,status:state.status,credited:state.credited});
  } catch(e) {
    console.error('[MARZPAY] webhook not reconciled:',e.message);
    return res.status(503).json({received:false,error:'Could not independently verify this callback with MARZ Pay; no wallet credit was made.'});
  }
};
app.post(['/api/marzpay/webhook','/api/marzpay/callback'], handleMarzPayWebhook);
app.get('/api/team', authenticate, async (req, res) => {
  try {
    let user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Referral code is persistent. Migrate a legacy code only when it is not
    // exactly six alphanumeric characters, and always write to the actual
    // Firestore document ID returned by findUserById (not a possibly stale id
    // copied into an older user record). Once valid, never regenerate it.
    const userDocId = user._docId || req.user.id;
    const currentReferralCode = String(user.referralCode || '').trim();
    if (!/^[A-Z0-9]{6}$/.test(currentReferralCode)) {
      const newCode = await generateUniqueReferralCode();
      const aliases = [...new Set([...(Array.isArray(user.legacyReferralCodes) ? user.legacyReferralCodes : []), ...(currentReferralCode ? [currentReferralCode] : [])])];
      const userRef = usersCollection.doc(userDocId);
      await db.runTransaction(async (tx) => {
        const latestSnap = await tx.get(userRef);
        if (!latestSnap.exists) throw new Error('User record not found while saving referral code');
        const latest = latestSnap.data();
        const latestCode = String(latest.referralCode || '').trim();
        if (!/^[A-Z0-9]{6}$/.test(latestCode)) {
          tx.update(userRef, { referralCode: newCode, legacyReferralCodes: [...new Set([...(Array.isArray(latest.legacyReferralCodes) ? latest.legacyReferralCodes : []), ...(latestCode ? [latestCode] : [])])], referralCodeVersion: 2 });
          user = { ...latest, _docId: userDocId, referralCode: newCode, legacyReferralCodes: aliases, referralCodeVersion: 2 };
        } else {
          user = { ...latest, _docId: userDocId };
        }
      });
    }
    const memberNames = {
      level1: Array.isArray(user.level1) ? user.level1 : [],
      level2: Array.isArray(user.level2) ? user.level2 : [],
      level3: Array.isArray(user.level3) ? user.level3 : []
    };
    const levels = {};
    for (const [level, names] of Object.entries(memberNames)) {
      levels[level] = await Promise.all([...new Set(names)].map(async name => {
        const member = await findUser(name);
        if (!member) return { username: name, joinedAt: null, status: 'Unknown' };
        return {
          username: member.username || name,
          joinedAt: member.createdAt || member.registered || null,
          status: member.status || (member.disabled ? 'Inactive' : 'Active')
        };
      }));
    }
    const commissions = {1:0,2:0,3:0,...(user.commissions || {})};
    const allMembers = [...levels.level1, ...levels.level2, ...levels.level3];
    // A member is active when they have ever purchased at least one product/rental.
    for (const member of allMembers) {
      const record = await findUser(member.username);
      const products = record?.products || [];
      member.status = products.length > 0 || Boolean(record?.hasPurchasedProduct) ? 'Active' : 'Inactive';
    }
    const teamIncome = Number(user.totalTeamIncome ?? (Number(commissions[1]||0)+Number(commissions[2]||0)+Number(commissions[3]||0)));
    res.json({
      referralCode: user.referralCode || null,
      referralLink: `https://frontend-deploy-plum-nu.vercel.app/?ref=${encodeURIComponent(user.referralCode || '')}`,
      level1: levels.level1, level2: levels.level2, level3: levels.level3,
      downlines: user.downlines || [], commissions,
      totalInvitations: new Set(allMembers.map(m => m.username)).size,
      activeMembers: allMembers.filter(m => m.status === 'Active').length,
      totalTeamIncome: teamIncome,
      yourBonus: Number(user.yourBonus || 0)
    });
  } catch (e) {
    console.error('[TEAM] Could not load team:', e.message);
    res.status(500).json({ error: 'Could not load team data' });
  }
});


// Named database only: all money mutations are server-side transactions.
const rentalsCollection = db.collection('rentals');
const earningsCollection = db.collection('earnings');
app.post('/api/rent', authenticate, async (req,res) => {
  try {
    const product = PRODUCTS.find(p => String(p.id) === String(req.body?.productId));
    if (!product) return res.status(400).json({error:'Invalid product'});
    const userRef = usersCollection.doc(req.user.id), rentalRef = rentalsCollection.doc(), txRef = transactionsCollection.doc();
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef); if(!snap.exists) throw new Error('User not found');
      const u=snap.data(), recharge=amountOf(u,'rechargeBalance'), earnings=amountOf(u,'earningsBalance');
      if(recharge < product.price) throw new Error('Please recharge, insufficient balance');
      const rentedAt = new Date(), expiresAt = new Date(rentedAt.getTime() + product.cycleDays*86400000);
      const rental = {userId:req.user.id,productId:product.id,name:product.name,price:product.price,dailyIncome:product.dailyIncome,duration:product.cycleDays,status:'active',rentedAt:admin.firestore.Timestamp.fromDate(rentedAt),expiresAt:admin.firestore.Timestamp.fromDate(expiresAt),lastPayoutDate:null,nextPayoutAt:admin.firestore.Timestamp.fromDate(new Date(rentedAt.getTime()+86400000)),createdAt:SERVER_TIME()};
      const userProducts=[...(u.products||[]),{productId:product.id,name:product.name,price:product.price,dailyIncome:product.dailyIncome,duration:product.cycleDays,active:true,rentalId:rentalRef.id,rentedAt:admin.firestore.Timestamp.fromDate(rentedAt),expiresAt:admin.firestore.Timestamp.fromDate(expiresAt)}];
      tx.update(userRef,{...setWallets(u,recharge-product.price,earnings),products:userProducts});
      tx.set(rentalRef,rental); tx.set(txRef,{userId:req.user.id,type:'rent',amount:-product.price,productId:product.id,status:'success',createdAt:SERVER_TIME()});
      return {rentalId:rentalRef.id,balance:recharge-product.price};
    });
    console.log('Rental created',req.user.id,product.id); res.status(201).json({message:'Rented successfully, daily income will start',...result});
  } catch(e) { console.error('Rent failed',e); res.status(400).json({error:e.message}); }
});

app.post('/api/withdrawals', authenticate, async (req,res) => {
  const minWithdraw = Number(process.env.MIN_WITHDRAWAL || 500);
  let withdrawalId = null;
  let attemptedWithdrawal = null;
  try {
    // `amount` is the gross amount deducted from the user's withdrawal wallet.
    // The provider receives the net amount after the server-calculated 15% fee.
    const amount = Number(req.body?.amount);
    const feeRate = 0.15;
    const feeAmount = Number.isSafeInteger(amount) ? Math.round(amount * feeRate) : 0;
    const payoutAmount = amount - feeAmount;
    const phone = ugPhoneE164(req.body?.phone_number || req.body?.phone);
    const requestedNetwork = String(req.body?.network || '').toUpperCase();
    attemptedWithdrawal = {amount,feeRate,feeAmount,payoutAmount,phoneNumber:phone,network:requestedNetwork};
    if (!['MTN','AIRTEL'].includes(requestedNetwork)) return res.status(400).json({error:'Select MTN or Airtel as the mobile-money network.'});
    if (!Number.isSafeInteger(amount) || amount < minWithdraw) return res.status(400).json({error:`Minimum withdrawal is ${minWithdraw} UGX`});
    if (!Number.isSafeInteger(payoutAmount) || payoutAmount <= 0) return res.status(400).json({error:'Withdrawal amount is too small after the 15% fee.'});
    // Record blocked payout attempts in Cash Record without reserving/debiting funds.
    // This makes a disabled/unconfigured payout visible as failed instead of disappearing.
    const recordBlockedWithdrawal = async (reason, code) => {
      const ref = transactionsCollection.doc();
      await ref.set({
        userId: req.user.id, type: 'withdrawal', amount, feeRate, feeAmount, payoutAmount,
        status: 'failed', failureReason: reason, failureCode: code,
        currency: 'UGX', phoneNumber: phone, network: requestedNetwork,
        createdAt: SERVER_TIME(), updatedAt: SERVER_TIME(), walletDebited: false,
      });
    };
    // The dashboard confirms MTN and Airtel Disbursement subscriptions.
    // Do not report a provider/merchant permission error locally: allow the
    // authenticated request to reach MARZ Pay when credentials are configured.
    // An operator can still hard-disable live payouts with an explicit false.
    if (String(process.env.MARZPAY_DISABLE_LIVE_PAYOUTS || '').trim().toLowerCase() === 'true') {
      const reason = 'Live mobile-money payouts are disabled by the Rhinoverse backend configuration.';
      await recordBlockedWithdrawal(reason, 'PAYOUTS_DISABLED');
      return res.status(503).json({error:reason,status:'failed',walletDebited:false});
    }
    if (!marzPayConfigured()) {
      const reason = 'MARZ Pay API credentials are not configured.';
      await recordBlockedWithdrawal(reason, 'MARZPAY_NOT_CONFIGURED');
      return res.status(503).json({error:reason,status:'failed',walletDebited:false});
    }

    const userRef = usersCollection.doc(req.user.id), withdrawalRef = withdrawalsCollection.doc(), txRef = transactionsCollection.doc();
    await db.runTransaction(async tx => {
      const snap = await tx.get(userRef); if (!snap.exists) throw new Error('User not found');
      const u = snap.data(), earnings = amountOf(u,'earningsBalance');
      const products = u.products || [];
      if (!(products.length > 0 || u.hasPurchasedProduct)) throw new Error('Purchase at least one product before withdrawing.');
      if (earnings < amount) throw new Error('Insufficient withdrawal balance. The entered amount includes the 15% withdrawal fee.');
      tx.update(userRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings-amount),pendingWithdrawal:Number(u.pendingWithdrawal||0)+amount});
      tx.create(withdrawalRef,{userId:req.user.id,amount,feeRate,feeAmount,payoutAmount,phoneNumber:phone,network:requestedNetwork,status:'processing',createdAt:SERVER_TIME(),updatedAt:SERVER_TIME(),currency:'UGX',automatic:true,provider:'marzpay'});
      tx.create(txRef,{userId:req.user.id,type:'withdrawal',amount,feeAmount,payoutAmount,status:'processing',createdAt:SERVER_TIME(),withdrawalId:withdrawalRef.id,currency:'UGX',phoneNumber:phone,network:requestedNetwork});
    });
    withdrawalId = withdrawalRef.id;
    try {
      const clientReference = crypto.randomUUID();
      // Persist the merchant reference before calling the provider. If Render loses
      // the response, operations can reconcile this exact request without retrying it.
      await withdrawalsCollection.doc(withdrawalId).update({
        providerClientReference: clientReference,
        requestStartedAt: SERVER_TIME(),
        updatedAt: SERVER_TIME()
      });
      const result = await marzPayRequest('/send-money','POST',{
        amount:payoutAmount, phone_number:phone, reference:clientReference, country:'UG',
        description:`Rhinoverse withdrawal ${withdrawalId}`,
        ...(process.env.MARZPAY_CALLBACK_URL ? {callback_url:process.env.MARZPAY_CALLBACK_URL} : {})
      }, {route:'withdrawal'});
      const root = unwrapped(result), providerTx = transactionFrom(result), withdrawal = root.withdrawal || {};
      const providerReference = String(providerTx.uuid || root.uuid || providerTx.reference || withdrawal.uuid || withdrawal.reference || '');
      // Only a payout/transaction status is authoritative. A top-level API
      // status of "success" can merely mean that the request was accepted.
      const status = String(providerTx.status || withdrawal.status || root.disbursement?.status || root.transfer?.status || 'pending').toLowerCase();
      await withdrawalsCollection.doc(withdrawalId).update({providerReference:providerReference||null,providerClientReference:clientReference,providerStatus:status,updatedAt:SERVER_TIME()});
      if (successfulStatus(status)) {
        await updateWithdrawalTransaction(withdrawalId,'paid',providerReference,{providerStatus:status,automatic:true});
        return res.json({message:'Mobile-money withdrawal confirmed by MARZ Pay.',status:'paid',withdrawalId,amount,feeAmount,payoutAmount,providerReference});
      }
      if (failedStatus(status)) {
        const providerMessage = String(root.message || result.message || withdrawal.message || 'MARZ Pay reported that the payout failed.').slice(0,300);
        await updateWithdrawalTransaction(withdrawalId,'failed_refunded',providerReference,{
          providerStatus:status,automatic:true,providerError:providerMessage,failureReason:providerMessage
        });
        return res.status(502).json({error:providerMessage,status:'failed_refunded',withdrawalId});
      }
      await withdrawalsCollection.doc(withdrawalId).update({status:'provider_pending',updatedAt:SERVER_TIME()});
      const history = await transactionsCollection.where('withdrawalId','==',withdrawalId).limit(1).get();
      if (!history.empty) await history.docs[0].ref.update({status:'pending',providerStatus:status||'pending',updatedAt:SERVER_TIME()});
      return res.status(202).json({message:'Withdrawal sent to MARZ Pay. The payout is pending provider confirmation.',status:'pending',withdrawalId,providerReference});
    } catch (providerError) {
      const definitive = providerError.status && providerError.status < 500;
      const providerMessage = String(providerError.message || 'MARZ Pay returned an unknown payout error.').slice(0,300);
      if (definitive) {
        await updateWithdrawalTransaction(withdrawalId,'failed_refunded',null,{
          automatic:true,providerError:providerMessage,failureReason:providerMessage
        });
      } else {
        await withdrawalsCollection.doc(withdrawalId).update({status:'provider_unknown',providerError:providerMessage,updatedAt:SERVER_TIME()});
        // The provider may have accepted the payout despite a timeout. Keep the
        // corresponding Cash Record visible as pending; never refund/retry blindly.
        const history = await transactionsCollection.where('withdrawalId','==',withdrawalId).limit(1).get();
        if (!history.empty) await history.docs[0].ref.update({status:'pending',providerStatus:'unknown',providerError:providerMessage,updatedAt:SERVER_TIME()});
      }
      return res.status(definitive?502:202).json({error:definitive?'MARZ Pay rejected the payout; reserved funds were returned.':'MARZ Pay response is uncertain. Funds remain reserved while status is reconciled; do not submit again yet.',status:definitive?'failed_refunded':'provider_unknown',withdrawalId,amount,feeAmount,payoutAmount});
    }
  } catch(e) {
    // Record valid withdrawal attempts rejected by local account/balance checks too.
    // No wallet amount is reserved unless the reservation transaction completed.
    if (!withdrawalId && attemptedWithdrawal && Number.isSafeInteger(attemptedWithdrawal.amount) && attemptedWithdrawal.amount > 0) {
      await transactionsCollection.add({
        userId:req.user.id,type:'withdrawal',...attemptedWithdrawal,status:'failed',
        failureReason:String(e.message||'Withdrawal could not be started').slice(0,300),
        currency:'UGX',walletDebited:false,createdAt:SERVER_TIME(),updatedAt:SERVER_TIME()
      }).catch(recordError=>console.error('Could not record rejected withdrawal:',recordError.message));
    }
    console.error('Automatic mobile-money withdrawal failed:',e.message);
    return res.status(400).json({error:e.message});
  }
});

app.get('/api/withdrawals/:id/status', authenticate, async (req,res) => {
  try {
    const ref = withdrawalsCollection.doc(String(req.params.id)), snap = await ref.get();
    if (!snap.exists || snap.data().userId !== req.user.id) return res.status(404).json({error:'Withdrawal not found.'});
    const w = snap.data();
    if (['paid','failed_refunded','rejected'].includes(w.status)) return res.json({status:w.status,message:w.status==='paid'?'Withdrawal paid successfully.': 'Withdrawal failed and funds were returned.'});
    if (!w.providerReference) return res.json({status:w.status,message:'Waiting for provider reference; check again shortly.'});
    const data = await marzPayRequest(`/send-money/${encodeURIComponent(w.providerReference)}`, 'GET', undefined, {route:'withdrawal'}), status = statusFrom(data);
    if (successfulStatus(status)) await updateWithdrawalTransaction(req.params.id,'paid',w.providerReference,{providerStatus:status});
    else if (failedStatus(status)) await updateWithdrawalTransaction(req.params.id,'failed_refunded',w.providerReference,{providerStatus:status});
    else await ref.update({status:'provider_pending',providerStatus:status||'pending',updatedAt:SERVER_TIME()});
    const finalStatus = successfulStatus(status)?'paid':failedStatus(status)?'failed_refunded':'provider_pending';
    return res.json({status:finalStatus,message:finalStatus==='paid'?'Withdrawal paid successfully.':finalStatus==='failed_refunded'?'Withdrawal failed and funds were returned.':'Withdrawal is still awaiting MARZ Pay confirmation.'});
  } catch(e) { console.error('Withdrawal status refresh failed:',e.message); return res.status(502).json({error:'Could not refresh payout status. Check again later.'}); }
});

const adminSecretMatches = (provided) => {
  const secret=process.env.ADMIN_API_SECRET;
  if(!secret||!provided)return false;
  const a=Buffer.from(String(secret)),b=Buffer.from(String(provided));
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
};
const requireAdminSecret = (req,res) => {
  if(!adminSecretMatches(req.headers['x-admin-secret'])) { res.status(401).json({error:'Admin access denied. Set ADMIN_API_SECRET on the backend and enter it in the admin panel.'}); return false; }
  return true;
};

// Admin-protected diagnostic retained at its old URL for compatibility.
// It now checks Render direct egress; it does not use NODE4_PROXY_URL.
app.get('/api/admin/marzpay-proxy-test', async (req, res) => {
  if (!requireAdminSecret(req, res)) return;
  try {
    const response = await nodeFetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`IP echo service returned HTTP ${response.status}`);
    const data = await response.json();
    const exitIp = String(data.ip || '').trim();
    if (!exitIp) throw new Error('IP echo service returned no IP address.');
    return res.json({ ip: exitIp, exitIp, directConnection: true, proxyUsed: false, success: true,
      note: 'This is the Render direct outbound IP observed for this request. It may differ if the hosting egress IP changes.' });
  } catch (error) {
    return res.status(502).json({ ip: null, exitIp: null, directConnection: false, proxyUsed: false,
      error: String(error.message || 'Direct connection test failed').slice(0, 300) });
  }
});

// TEMPORARY, admin-protected one-time test credit. Enable explicitly in Render,
// then POST { userId } with X-Admin-Secret. This is simulated test balance, not real funds.
app.post('/api/admin/test-credit-50000', async (req,res) => {
  if (!requireAdminSecret(req,res)) return;
  if (String(process.env.ENABLE_TEST_WALLET_CREDIT || '').toLowerCase() !== 'true')
    return res.status(403).json({error:'Test wallet credit is disabled. Set ENABLE_TEST_WALLET_CREDIT=true temporarily in Render.'});
  const userId = String(req.body?.userId || '').trim();
  if (!userId || userId.length > 160) return res.status(400).json({error:'Provide your own Firestore userId.'});
  const amount = 50000;
  const creditId = `test_credit_50000_${userId}`;
  const userRef = usersCollection.doc(userId);
  const creditRef = transactionsCollection.doc(creditId);
  try {
    let alreadyCredited = false;
    let newBalance = null;
    await db.runTransaction(async tx => {
      const [userSnap, creditSnap] = await Promise.all([tx.get(userRef), tx.get(creditRef)]);
      if (!userSnap.exists) throw new Error('User not found. Check the Firestore document ID.');
      if (creditSnap.exists) { alreadyCredited = true; newBalance = amountOf(userSnap.data(),'earningsBalance'); return; }
      const user = userSnap.data();
      newBalance = amountOf(user,'earningsBalance') + amount;
      tx.update(userRef, { ...setWallets(user, amountOf(user,'rechargeBalance'), newBalance), updatedAt: SERVER_TIME() });
      tx.create(creditRef, { userId, type:'test_wallet_credit', amount, currency:'UGX', status:'success', note:'Temporary test credit; not real funds.', createdAt:SERVER_TIME() });
    });
    return res.json({success:true, credited:!alreadyCredited, alreadyCredited, amount, withdrawalBalance:newBalance, message:alreadyCredited?'This one-time test credit was already applied.':'50,000 UGX test credit added to the withdrawal wallet.'});
  } catch(e) {
    console.error('[TEST CREDIT] failed:', e.message);
    return res.status(e.message==='User not found. Check the Firestore document ID.'?404:500).json({error:e.message||'Test credit failed.'});
  }
});

// Admin-only, read-only MarzPay preflight. This distinguishes IP/authentication,
// wallet-balance and product-permission problems without creating a real payout.
app.get('/api/admin/marzpay/diagnostics', async (req,res) => {
  if(!requireAdminSecret(req,res)) return;
  const check = async (name, path) => {
    try {
      const result = await marzPayRequest(path, 'GET');
      const root = unwrapped(result);
      const account = root.account || {};
      const balance = account.available_balance || account.balance || {};
      return {name, ok:true, providerStatus:result.status || 'success', message:result.message || null,
        availableBalance:balance.raw ?? null, currency:balance.currency || 'UGX',
        accountStatus:account.status?.account_status || null, frozen:account.status?.is_frozen ?? null,
        data: name === 'send_money_services' ? root : undefined};
    } catch (e) {
      const provider = e.providerResponse || {};
      return {name, ok:false, httpStatus:e.status || null, message:String(provider.message || provider.error || e.message || 'Provider request failed').slice(0,300)};
    }
  };
  const results = await Promise.all([
    check('uganda_balance', '/balance?country=UG'),
    check('send_money_services', '/send-money/services?country=UG')
  ]);
  const ok = results.every(x => x.ok);
  return res.status(ok ? 200 : 502).json({ok, apiBase:MARZPAY_API_BASE, checks:results,
    note:'Read-only preflight only. A successful response does not prove live disbursement permission; MarzPay must confirm that separately.'});
});
app.get('/api/admin/withdrawals', async(req,res)=>{
  if(!requireAdminSecret(req,res)) return;
  try {
    const status=String(req.query.status||'pending'),snap=await withdrawalsCollection.get(),items=[];
    for(const doc of snap.docs) {
      const w=doc.data(); if(status!=='all'&&w.status!==status)continue;
      const u=await findUserById(w.userId),a=u?.boundAccount||{};
      items.push({id:doc.id,userId:w.userId,username:u?.username||'',phone:u?.phone||'',amount:Number(w.amount||0),currency:w.currency||'UGX',status:w.status,createdAt:w.createdAt?.toDate?.()?.toISOString?.()||w.createdAt||null,bankName:a.bankName||'',holderName:a.holderName||'',accountLast4:String(a.accountNumber||'').slice(-4),providerReference:w.providerReference||null,providerStatus:w.providerStatus||null});
    }
    items.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.json({success:true,data:items});
  } catch(e){res.status(500).json({error:'Unable to load withdrawal requests.'});}
});

async function updateWithdrawalTransaction(withdrawalId, status, providerReference, extra = {}) {
  const wRef=withdrawalsCollection.doc(withdrawalId);
  await db.runTransaction(async tx=>{
    const wSnap=await tx.get(wRef); if(!wSnap.exists)throw new Error('Withdrawal not found');
    const w=wSnap.data();
    if(['paid','rejected','failed_refunded'].includes(w.status))return;
    const uRef=usersCollection.doc(w.userId),uSnap=await tx.get(uRef);
    const historySnap=await tx.get(transactionsCollection.where('withdrawalId','==',withdrawalId).limit(1));
    if(!uSnap.exists)throw new Error('User not found');
    const u=uSnap.data();
    if(status==='rejected'||status==='failed_refunded') {
      const earnings=amountOf(u,'earningsBalance')+Number(w.amount||0);
      tx.update(uRef,{...setWallets(u,amountOf(u,'rechargeBalance'),earnings),pendingWithdrawal:Math.max(0,Number(u.pendingWithdrawal||0)-Number(w.amount||0))});
    } else if(status==='paid') {
      tx.update(uRef,{pendingWithdrawal:Math.max(0,Number(u.pendingWithdrawal||0)-Number(w.amount||0))});
    }
    tx.update(wRef,{status,providerReference:providerReference||w.providerReference||null,...extra,updatedAt:SERVER_TIME()});
    if(!historySnap.empty)tx.update(historySnap.docs[0].ref,{
      status:status==='paid'?'success':status==='rejected'||status==='failed_refunded'?'failed':status,
      providerReference:providerReference||w.providerReference||null,
      ...extra,
      updatedAt:SERVER_TIME()
    });
  });
}

async function refreshBankTransfer(withdrawalId) {
  const wRef=withdrawalsCollection.doc(withdrawalId),snap=await wRef.get();
  if(!snap.exists)throw new Error('Withdrawal not found');
  const w=snap.data(); if(!w.providerReference)throw new Error('No MARZ Pay transfer reference exists yet.');
  const data=await marzPayRequest(w.phoneNumber ? `/send-money/${encodeURIComponent(w.providerReference)}` : `/bank-transfer/${encodeURIComponent(w.providerReference)}`, 'GET', undefined, {route:'withdrawal'}),status=statusFrom(data);
  if(successfulStatus(status))await updateWithdrawalTransaction(withdrawalId,'paid',w.providerReference,{providerStatus:status});
  else if(failedStatus(status))await updateWithdrawalTransaction(withdrawalId,'failed_refunded',w.providerReference,{providerStatus:status});
  else await wRef.update({status:'provider_pending',providerStatus:status||'pending',updatedAt:SERVER_TIME()});
  return {status:successfulStatus(status)?'paid':failedStatus(status)?'failed_refunded':'provider_pending',providerStatus:status||'pending'};
}
app.post('/api/admin/withdrawals/:id/refresh', async(req,res)=>{
  if(!requireAdminSecret(req,res))return;
  try{res.json({success:true,...await refreshBankTransfer(req.params.id)});}
  catch(e){res.status(502).json({error:e.message||'Unable to check MARZ Pay transfer status.'});}
});
app.post('/api/admin/withdrawals/:id/:action', async(req,res)=>{
  if(!requireAdminSecret(req,res))return;
  const {id,action}=req.params;
  if(!['approve','reject'].includes(action))return res.status(400).json({error:'Invalid action'});
  try {
    const wRef=withdrawalsCollection.doc(id),snap=await wRef.get();
    if(!snap.exists)return res.status(404).json({error:'Withdrawal not found'});
    const w=snap.data();
    if(w.status!=='pending')return res.status(409).json({error:`Withdrawal is ${w.status}, not pending.`});
    if(action==='reject') {
      await updateWithdrawalTransaction(id,'rejected',null,{adminReviewedAt:SERVER_TIME()});
      return res.json({message:'Withdrawal rejected. Reserved funds were returned to the user.',status:'rejected'});
    }
    if(process.env.MARZPAY_ENABLE_LIVE_PAYOUTS!=='true')return res.status(503).json({error:'Live bank payouts are disabled. Confirm bank-transfer access, IP allowlisting, permissions and fees before setting MARZPAY_ENABLE_LIVE_PAYOUTS=true.'});
    if(!marzPayConfigured())return res.status(503).json({error:'MARZ Pay API credentials are not configured.'});
    const user=await findUserById(w.userId),account=user?.boundAccount;
    if(!account?.bankName||!account?.accountNumber||!account?.holderName)return res.status(400).json({error:'The user has no complete bound bank account.'});
    await db.runTransaction(async tx=>{const cur=await tx.get(wRef);if(!cur.exists||cur.data().status!=='pending')throw new Error('Withdrawal is no longer pending');tx.update(wRef,{status:'processing',adminApprovedAt:SERVER_TIME(),updatedAt:SERVER_TIME()});});
    let result;
    try {
      await marzPayRequest('/bank-transfer/validate','POST',{bank_name:account.bankName,account_number:account.accountNumber}, {route:'withdrawal'});
      result=await marzPayRequest('/bank-transfer','POST',{amount:Number(w.amount),description:`Rhinoverse withdrawal ${id}`,bank_name:account.bankName,bank_account_number:account.accountNumber,bank_account_name:account.holderName,wallet_source:'main',...(account.bankBranch?{bank_branch:account.bankBranch}:{})}, {route:'withdrawal'});
    } catch(providerError) {
      if(providerError.status&&providerError.status<500)await wRef.update({status:'pending',providerError:String(providerError.message).slice(0,300),updatedAt:SERVER_TIME()});
      else await wRef.update({status:'provider_unknown',providerError:String(providerError.message).slice(0,300),updatedAt:SERVER_TIME()});
      return res.status(providerError.status&&providerError.status<500?502:202).json({error:'MARZ Pay did not return a confirmed bank-transfer result. The withdrawal remains reserved for reconciliation; do not approve it again until status is checked.'});
    }
    const root=unwrapped(result),providerTx=transactionFrom(result);
    const providerReference=String(providerTx.reference||root.reference||root.transfer?.reference||'');
    if(!providerReference) {await wRef.update({status:'provider_unknown',providerResponseReceived:true,updatedAt:SERVER_TIME()});return res.status(202).json({error:'MARZ Pay returned no bank-transfer reference. Funds remain reserved; reconcile before retrying.'});}
    const status=String(providerTx.status||'pending').toLowerCase();
    if(successfulStatus(status)){await updateWithdrawalTransaction(id,'paid',providerReference,{providerStatus:status,providerResponseReceived:true});return res.json({message:'MARZ Pay completed the bank transfer.',status:'paid',providerReference});}
    if(failedStatus(status)){await updateWithdrawalTransaction(id,'failed_refunded',providerReference,{providerStatus:status,providerResponseReceived:true});return res.status(502).json({error:'MARZ Pay reported that the bank transfer failed. Reserved funds were returned.',status:'failed_refunded'});}
    await wRef.update({status:'provider_pending',providerReference,providerStatus:status,providerResponseReceived:true,updatedAt:SERVER_TIME()});
    return res.status(202).json({message:'Bank transfer submitted to MARZ Pay and awaiting final status.',status:'provider_pending',providerReference});
  } catch(e){console.error('Admin withdrawal action failed:',e.message);return res.status(500).json({error:e.message||'Admin withdrawal action failed.'});}
});
// Production daily earnings: credit one full configured dailyIncome after each completed 24-hour period.
// Cloudflare Cron checks every 5 minutes; it never prorates or pays partial five-minute amounts.
app.post('/api/cron/daily-earnings', async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date();
  const bucket = Math.floor(now.getTime() / 300000);
  let credited = 0, skipped = 0, expired = 0, totalAmount = 0;
  try {
    // Repair legacy purchases created before rental records were consistently written.
    // A deterministic rental ID makes this migration safe to run on every 5-minute cron.
    const usersSnap = await usersCollection.get();
    let legacyLinked = 0;
    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      const products = Array.isArray(user.products) ? user.products : [];
      const repairedProducts = products.slice();
      let userProductsChanged = false;
      for (let i = 0; i < products.length; i++) {
        const product = products[i] || {};
        if (product.rentalId || product.rentalStatus === 'expired') continue;
        const productKey = product.productId?.id || product.productId || product.id;
        const catalogProduct = PRODUCTS.find(p => String(p.id) === String(productKey) || p.name.toLowerCase() === String(product.name || product.productId?.name || '').trim().toLowerCase());
        const dailyIncome = Number(product.dailyIncome || product.productId?.dailyIncome || catalogProduct?.dailyIncome || 0);
        if (!Number.isFinite(dailyIncome) || dailyIncome <= 0) continue;
        const startValue = product.rentedAt || product.purchaseDate || product.purchasedAt || product.createdAt;
        const start = startValue?.toDate ? startValue.toDate() : (startValue ? new Date(startValue) : null);
        if (!start || !Number.isFinite(start.getTime())) continue;
        const duration = Math.max(1, Number(product.duration || product.cycleDays || 60));
        const expiryValue = product.expiresAt || product.expiryDate;
        const expiry = expiryValue?.toDate ? expiryValue.toDate() : (expiryValue ? new Date(expiryValue) : new Date(start.getTime() + duration * 86400000));
        if (!Number.isFinite(expiry.getTime())) continue;
        const stableKey = crypto.createHash('sha256').update(`${userDoc.id}|${product.productId || product.id || product.name || 'product'}|${start.toISOString()}|${i}`).digest('hex').slice(0, 32);
        const legacyRentalRef = rentalsCollection.doc(`legacy_${stableKey}`);
        const legacyRentalSnap = await legacyRentalRef.get();
        const isActive = now < expiry;
        if (!legacyRentalSnap.exists && isActive) {
          await legacyRentalRef.create({
            userId: userDoc.id, productId: Number(product.productId || product.id) || null,
            name: product.name || product.productId?.name || catalogProduct?.name || 'Rhinoverse Product',
            price: Number(product.price || product.productId?.price || catalogProduct?.price || 0), dailyIncome,
            duration, status: 'active', rentedAt: admin.firestore.Timestamp.fromDate(start),
            expiresAt: admin.firestore.Timestamp.fromDate(expiry),
            nextPayoutAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 86400000)),
            legacyMigrated: true, createdAt: SERVER_TIME()
          });
          legacyLinked++;
        }
        if (product.active !== isActive || (!product.rentalId && isActive) || product.rentalStatus !== (isActive ? 'active' : 'expired')) {
          repairedProducts[i] = { ...product, active: isActive, rentalId: product.rentalId || (legacyRentalSnap.exists ? legacyRentalRef.id : (isActive ? legacyRentalRef.id : null)), rentalStatus: isActive ? 'active' : 'expired' };
          userProductsChanged = true;
        }
      }
      if (userProductsChanged) await usersCollection.doc(userDoc.id).update({ products: repairedProducts, updatedAt: SERVER_TIME() });
    }
    if (legacyLinked) console.log('[DAILY EARNINGS CRON] legacy products linked:', legacyLinked);

    const activeRentals = await rentalsCollection.where('status', '==', 'active').get();
    for (const rentalDoc of activeRentals.docs) {
      const rentalRef = rentalsCollection.doc(rentalDoc.id);
      const initial = rentalDoc.data();
      if (!initial.userId || !Number.isFinite(Number(initial.dailyIncome)) || Number(initial.dailyIncome) <= 0 || !initial.rentedAt) {
        skipped++;
        continue;
      }
      const userRef = usersCollection.doc(initial.userId);
      const initialNext = initial.nextPayoutAt?.toDate ? initial.nextPayoutAt.toDate() : (initial.nextPayoutAt ? new Date(initial.nextPayoutAt) : null);
      // Migrate existing active rentals safely: start a fresh 24-hour period from
      // the first run after this version is deployed, preventing duplicate back-pay.
      if (!initialNext || !Number.isFinite(initialNext.getTime())) {
        await rentalRef.update({ nextPayoutAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 86400000)), updatedAt: SERVER_TIME() });
        skipped++;
        continue;
      }
      if (now < initialNext) { skipped++; continue; }
      const dueAt = initialNext;
      const key = dueAt.getTime();
      const payoutRef = earningsCollection.doc(`daily_${rentalDoc.id}_${key}`);
      const txRef = transactionsCollection.doc(`daily_${rentalDoc.id}_${key}`);
      const outcome = await db.runTransaction(async tx => {
        const [rentalSnap, userSnap, payoutSnap, cashSnap] = await Promise.all([
          tx.get(rentalRef), tx.get(userRef), tx.get(payoutRef), tx.get(txRef)
        ]);
        if (!rentalSnap.exists || !userSnap.exists) return { status: 'missing', amount: 0 };
        const rental = rentalSnap.data();
        if (rental.status !== 'active') return { status: 'inactive', amount: 0 };
        const currentDue = rental.nextPayoutAt?.toDate ? rental.nextPayoutAt.toDate() : new Date(rental.nextPayoutAt);
        if (!Number.isFinite(currentDue.getTime()) || currentDue.getTime() !== key) return { status: 'changed', amount: 0 };
        const toDate = value => value?.toDate ? value.toDate() : new Date(value);
        const rentedAt = toDate(rental.rentedAt);
        const expiry = rental.expiresAt ? toDate(rental.expiresAt) : new Date(rentedAt.getTime() + Number(rental.duration || 60) * 86400000);
        if (currentDue > expiry) {
          tx.update(rentalRef, { status: 'expired', updatedAt: SERVER_TIME() });
          return { status: 'expired', amount: 0 };
        }
        const amount = Math.max(0, Math.floor(Number(rental.dailyIncome) || 0));
        if (!amount) return { status: 'invalid_amount', amount: 0 };
        const user = userSnap.data();
        const balance = amountOf(user, 'earningsBalance');
        const nextDue = new Date(currentDue.getTime() + 86400000);
        tx.update(rentalRef, { nextPayoutAt: admin.firestore.Timestamp.fromDate(nextDue), updatedAt: SERVER_TIME() });
        if (!payoutSnap.exists && !cashSnap.exists) {
          tx.update(userRef, {
            ...setWallets(user, amountOf(user, 'rechargeBalance'), balance + amount),
            totalEarnings: Number(user.totalEarnings || 0) + amount,
            updatedAt: SERVER_TIME()
          });
          tx.create(payoutRef, { userId: rental.userId, rentalId: rentalDoc.id, type: 'daily_income', amount, currency: 'UGX', status: 'success', createdAt: SERVER_TIME(), payoutFor: admin.firestore.Timestamp.fromDate(currentDue) });
          tx.create(txRef, { userId: rental.userId, rentalId: rentalDoc.id, type: 'daily_income', amount, currency: 'UGX', status: 'success', createdAt: SERVER_TIME(), reference: `daily_${rentalDoc.id}_${key}` });
          return { status: 'credited', amount };
        }
        return { status: 'duplicate', amount: 0 };
      });
      if (outcome.status === 'credited') { credited++; totalAmount += outcome.amount; }
      else if (outcome.status === 'expired') expired++;
      else skipped++;
    }
    // Reconcile outstanding automatic mobile-money withdrawals on the same
    // authenticated 5-minute Render Cron. Only provider-confirmed failures
    // are refunded; pending/unknown responses keep funds reserved.
    let withdrawalsChecked = 0, withdrawalsRefunded = 0, withdrawalsPaid = 0;
    for (const pendingStatus of ['processing', 'provider_pending']) {
      const pendingSnap = await withdrawalsCollection.where('status', '==', pendingStatus).limit(100).get();
      for (const withdrawalDoc of pendingSnap.docs) {
        const withdrawal = withdrawalDoc.data();
        const providerReference = String(withdrawal.providerReference || '').trim();
        if (!providerReference || !withdrawal.userId || withdrawal.provider !== 'marzpay') continue;
        try {
          const providerResult = await marzPayRequest(`/send-money/${encodeURIComponent(providerReference)}`, 'GET', undefined, { route: 'withdrawal' });
          const providerState = statusFrom(providerResult);
          withdrawalsChecked++;
          if (successfulStatus(providerState)) {
            await updateWithdrawalTransaction(withdrawalDoc.id, 'paid', providerReference, { providerStatus: providerState, cronReconciled: true });
            withdrawalsPaid++;
          } else if (failedStatus(providerState)) {
            const failureMessage = String(providerResult.message || providerResult.data?.message || 'MARZ Pay confirmed that the withdrawal failed.').slice(0, 300);
            await updateWithdrawalTransaction(withdrawalDoc.id, 'failed_refunded', providerReference, {
              providerStatus: providerState, cronReconciled: true,
              providerError: failureMessage, failureReason: failureMessage
            });
            withdrawalsRefunded++;
          }
        } catch (reconcileError) {
          // A timeout or provider/API error is not proof of failure: do not refund.
          console.error('[WITHDRAWAL RECONCILIATION] status check deferred:', withdrawalDoc.id, reconcileError.message);
        }
      }
    }
    console.log('[DAILY EARNINGS CRON]', { bucket, credited, skipped, expired, totalAmount, withdrawalsChecked, withdrawalsRefunded, withdrawalsPaid });
    return res.json({ success: true, intervalMinutes: 5, creditedRentals: credited, skipped, expired, totalAmount, withdrawalsChecked, withdrawalsRefunded, withdrawalsPaid, currency: 'UGX' });
  } catch (e) {
    console.error('[DAILY EARNINGS CRON] failed:', e);
    return res.status(500).json({ error: e.message || 'Daily earnings cron failed.' });
  }
});

// Legacy endpoint intentionally disabled: daily earnings are now accrued by
// /api/cron/daily-earnings every 5 minutes. Do not schedule this route.
app.post('/api/daily-payout', (_req, res) => res.status(410).json({
  error: 'This legacy daily payout endpoint is disabled. Use /api/cron/daily-earnings.'
}));

}

module.exports = app;

# Rhinoverse backend on Render

This package is configured as a Render Docker Web Service in the Frankfurt region. The frontend remains on Vercel. The backend continues to use the existing Firebase project and named Firestore database `rhinoverse`.

## Important MarzPay outbound-IP limitation

Render Hobby/free services use Render's shared regional outbound IP ranges. In the Render Dashboard, open the service, choose **Connect → Outbound**, and copy every displayed CIDR range. Ask MarzPay whether its IP Whitelist accepts CIDR ranges. If it does, submit all Frankfurt ranges. These ranges are shared with other Render services and Render may change them; they are not an exclusive static IP.

If MarzPay only accepts one dedicated IPv4 (or requires an exclusive merchant IP), this Render free deployment will NOT satisfy that requirement. Render Dedicated IPs require a Pro workspace or higher and currently cost an additional **$100/month per IP set**; each set contains three IPv4 addresses. Do not upgrade or buy this without confirming MarzPay's exact whitelist format and budget approval.

## Deploy from GitHub

1. Create a private GitHub repository for this backend and upload the contents of this folder to its repository root (including `render.yaml`, `Dockerfile`, `server.js`, `package.json`, and `api/`). Do not upload `.env` files or secrets.
2. In Render, choose **New → Blueprint**, connect the private repository, and apply the Blueprint. It creates a Docker web service in Frankfurt on the Free plan.
3. In the Render service's **Environment** page, enter the existing production values for the secret variables marked `sync: false`. Use the exact current production credentials; do not generate a new `JWT_SECRET`, as existing login tokens may depend on it.
4. Confirm `FIREBASE_PROJECT_ID` is `rhinoverse-2c104`; use the existing Firebase service account values. `FIREBASE_PRIVATE_KEY` must be the full PEM private key with newline characters preserved (or escaped as `\\n` if the backend normalizes them).
5. Confirm `MARZPAY_API_BASE` is `https://wallet.wearemarz.com/api/v1`, and keep the existing production MarzPay credentials. Do not enable real payouts until MarzPay confirms the server egress IP ranges are accepted and live disbursement access is enabled.
6. Wait for deploy. Test `https://<render-service>.onrender.com/api/health`. Expected JSON should show `status: healthy`, `db: rhinoverse`, and authentication configured.
7. Open **Connect → Outbound** and copy the complete list of IP ranges. Ask MarzPay whether it accepts CIDR ranges. If it does, add every range to its IP whitelist.
8. Only after health checks and MarzPay approval, update the frontend's API base URL to the Render service URL (or a custom API domain) and redeploy the frontend on Vercel.

## Important production cautions

- Render Free web services spin down after inactivity and can take time to wake. This can delay API requests and scheduled jobs. For a payment production system, use a paid always-on instance if needed; this alone does not provide a dedicated egress IP.
- Render's Free shared egress ranges are not a single exclusive IP. If MarzPay requires a single address, stop here and choose a host/proxy with a dedicated static outbound IPv4, or Render Pro with Dedicated IPs.
- Do not test a real withdrawal until MarzPay confirms whitelist acceptance and live payout permission.
- Do not change Firestore database selection, wallet balances, withdrawal fee, recharge routes, product settings, or referral logic during this hosting migration.
- Keep all secrets in Render Environment settings. Never commit or send them in chat.

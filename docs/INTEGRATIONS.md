# Connecting channels and lead sources

Business owners and admins connect everything from **Integrations** in the app. Some providers
also need a one-time app registration by whoever runs the server; those are marked
**server setup** below. Until that is done, the app shows the integration as
"Requires setup by your administrator". It never shows a connection as working when it isn't.

All credentials are stored encrypted. Disconnecting an integration deletes them.

| Integration | Gives you | Server setup needed |
|---|---|---|
| [Website forms](#website-forms) | Leads from your website | no |
| [Email (SMTP)](#email-smtp) | Sending acknowledgements and follow-ups | no |
| [Gmail](#gmail) | Sending from Gmail, reading replies, new leads from your inbox | yes, Google OAuth app |
| [WhatsApp Business (Cloud API)](#whatsapp-business-cloud-api) | Sending, receiving replies, delivery receipts | yes, Meta app (for webhooks) |
| [Facebook / Instagram lead ads](#facebook--instagram-lead-ads) | Leads from Meta lead forms | yes, Meta app |
| [HubSpot](#hubspot) | Importing new contacts as leads | no |
| Manual entry | Leads added in the app | no |

## Website forms

**Integrations → Website form → Create.** You get three ways to collect leads:

1. **Hosted form** at `<APP_URL>/f/<form key>`. Link to it, or embed it:
   `<iframe src="https://leads.example.com/f/wf_…" style="width:100%;height:640px;border:0"></iframe>`
2. **Your own HTML form** posting to `<APP_URL>/api/webhooks/website/<form key>/form`
   (snippet shown in the app). Add your site's address under *Allowed websites*. Spam protection:
   a hidden honeypot field, a minimum fill time, and per-visitor rate limits. These leads are
   marked "unverified".
3. **Server-to-server** (your backend, WordPress plugin, Zapier, …), signed with the form's secret:

   ```
   POST <APP_URL>/api/webhooks/website/<form key>
   Content-Type: application/json
   X-LFM-Timestamp: <unix seconds>
   X-LFM-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
   Idempotency-Key: <your submission id>      (optional; retries with the same key are ignored)

   {"name": "Rahul Sharma", "email": "rahul@example.com", "phone": "+91 98765 43210", "service": "Website"}
   ```

   Requests older than 5 minutes, or with a wrong signature, get `401`. Node.js example:

   ```js
   import { createHmac } from "node:crypto";
   const body = JSON.stringify(fields);
   const ts = Math.floor(Date.now() / 1000);
   const sig = "sha256=" + createHmac("sha256", process.env.LFM_FORM_SECRET).update(`${ts}.${body}`).digest("hex");
   await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-LFM-Timestamp": String(ts), "X-LFM-Signature": sig }, body });
   ```

Field names are matched loosely (`name`, `full_name`, `First Name` + `Last Name`, `email`,
`E-mail`, `phone`, `mobile`, `whatsapp`, `company`, `message`, `service`, …). Unknown fields are
kept on the lead. *Rotate secret* invalidates the old one immediately.

## Email (SMTP)

**Integrations → Email (SMTP).** Works with any provider that offers SMTP (Google Workspace with an
app password, Microsoft 365, Zoho, Amazon SES, Postmark, Brevo, your host's mail server).
Enter host, port, security (TLS on 465, STARTTLS on 587), username, password and the "from"
address. The app logs in to the server to test before saving; it shows "Connected" only if that
works.

Every email includes an unsubscribe link and one-click unsubscribe headers (RFC 8058), which
Gmail and Yahoo require for bulk senders. For good delivery, set up SPF, DKIM and DMARC for the
sending domain with your email provider.

SMTP sends only. To have customer replies recorded automatically and pause follow-ups, use Gmail,
or record replies by hand with **They got back to us** on the lead page.

## Gmail

**Server setup (once):**

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, enable the
   **Gmail API**, and configure the OAuth consent screen.
2. Create an **OAuth client ID** of type *Web application* with the redirect URI
   `<APP_URL>/api/integrations/callback/gmail`.
3. Put the client ID and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and restart.

The app asks for `gmail.send` and `gmail.readonly`. Google classes these as *restricted*: with
the consent screen in **Testing** mode, add each Gmail address as a test user (fine for one
business or a Google Workspace "Internal" app). Offering it publicly to other businesses requires
Google's verification and security assessment.

**In the app:** Integrations → Gmail → Connect, sign in, allow. The worker checks the inbox every
minute: replies to our emails are attached to the right lead and pause its follow-ups; optionally,
new emails from unknown senders become leads.

## WhatsApp Business (Cloud API)

**In the app (each business):** Integrations → WhatsApp. You need, from
[Meta Business Suite / WhatsApp Manager](https://business.facebook.com/):

- the **Phone number ID** of a number registered on the WhatsApp Cloud API, and
- a **permanent access token** of a System User with `whatsapp_business_messaging` and
  `whatsapp_business_management` permissions.

The app checks both with Meta before saving.

**Server setup (once), so replies and delivery receipts arrive:**

1. Create an app at [developers.facebook.com](https://developers.facebook.com/) with the WhatsApp
   product. Put its App ID and App Secret in `META_APP_ID` / `META_APP_SECRET`.
2. Choose any random string as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; restart.
3. In the app's WhatsApp → Configuration, set the callback URL to
   `<APP_URL>/api/webhooks/whatsapp`, enter the same verify token, and subscribe to the
   **messages** field.

**Rules the app follows:** a business can message a customer freely for 24 hours after the
customer's last message. Outside that window only templates **approved by Meta** can be sent. In
Settings → Messages, give each WhatsApp template the Meta template name and language; its
`{{variables}}` are sent as Meta's numbered parameters in the order they appear. Customers who
reply STOP are opted out of WhatsApp; START opts them back in. Automatic WhatsApp messages are
sent only to leads who agreed to WhatsApp contact (for example, the opt-in checkbox on your form)
or who messaged the business on WhatsApp in the last 24 hours.

## Facebook / Instagram lead ads

**Server setup (once):** the same Meta app as above (`META_APP_ID`, `META_APP_SECRET`), with
**Facebook Login for Business** added and the redirect URI
`<APP_URL>/api/integrations/callback/meta`. Under Webhooks, subscribe the **Page** object's
`leadgen` field with callback URL `<APP_URL>/api/webhooks/meta` and the same verify token.
The permissions used (`pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`,
`leads_retrieval`, `business_management`) need Meta **App Review** before businesses other than
the app's own admins and testers can connect.

**In the app:** Integrations → Facebook & Instagram lead ads → Connect, sign in, pick the Page.
The app subscribes the Page and confirms the subscription with Meta. Each new lead form
submission (from Facebook or Instagram ads on that Page) becomes a lead within seconds.

## HubSpot

**In HubSpot:** Settings → Integrations → Private apps → Create, with the scope
`crm.objects.contacts.read`. Copy the access token.

**In the app:** Integrations → HubSpot, paste the token. Contacts created in HubSpot *after*
connecting are imported as leads every 15 minutes (or now, with *Sync now*). Existing contacts
aren't imported, and duplicates are merged by email and phone number.

## Duplicate and retry safety (all sources)

Each provider event is recorded with its provider id before it is processed. A webhook delivered
twice, a form submitted twice with the same `Idempotency-Key`, or an inbox message seen twice
creates **one** lead. A new enquiry from someone who already has an open lead is added to that
lead (or flagged, depending on Settings → Automation → Duplicates) instead of creating a second.

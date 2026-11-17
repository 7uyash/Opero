import { NextResponse } from "next/server";

/**
 * Email inbox events. Gmail inboxes are read by the worker through the Gmail history API every
 * minute, which needs no public endpoint and works behind firewalls. Push delivery (Google Pub/Sub)
 * can be added here later; until then this endpoint explains how email is received.
 */
export function POST() {
  return NextResponse.json(
    {
      error: {
        code: "NOT_USED",
        message: "Email replies and inquiries are collected by polling connected Gmail inboxes; no webhook is needed.",
      },
    },
    { status: 410 },
  );
}

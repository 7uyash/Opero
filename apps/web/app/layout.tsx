import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Lead & Follow-up Manager", template: "%s · Lead & Follow-up Manager" },
  description: "Capture leads, assign your team and never miss a follow-up.",
  appleWebApp: { capable: true, title: "Leads", statusBarStyle: "default" },
};

// Phones render at their real width (without this they show a shrunken desktop page).
// Zoom stays allowed for accessibility.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}

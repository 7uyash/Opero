export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-12">
      <div className="w-full max-w-lg">
        <p className="mb-6 text-center text-sm font-semibold tracking-wide text-primary">Lead &amp; Follow-up Manager</p>
        {children}
      </div>
    </main>
  );
}

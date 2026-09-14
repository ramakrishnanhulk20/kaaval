import { TenantProviders } from "@/components/tenant/TenantProviders";
import { publicPrivyAppId, tenantConfigured } from "@/lib/tenant/env";

/**
 * The shell for the two screens a trader uses on their own account.
 *
 * On a host where sign-in has not been set up this renders one honest notice and no
 * screen at all. That is deliberate: a login button that cannot work is worse than a
 * sentence saying it is not configured yet.
 */
export default function TenantLayout({ children }: { children: React.ReactNode }) {
  const status = tenantConfigured();
  const appId = publicPrivyAppId();

  if (!status.signIn || appId === null) {
    return <NotConfigured missing={status.missing} />;
  }

  return <TenantProviders appId={appId}>{children}</TenantProviders>;
}

function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <div className="max-w-[60ch]">
        <p className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">Your own account</p>
        <h1
          className="mt-4 font-display font-extrabold text-ink"
          style={{ fontSize: "clamp(2.2rem, 7vw, 4.4rem)", letterSpacing: "-0.04em", lineHeight: 0.94 }}
        >
          Sign-in is not configured on this host
        </h1>
        <div className="mt-5 h-px w-full bg-amber" />
        <p className="mt-8 text-[17px] leading-relaxed text-ink/75">
          The account area needs a few settings before anybody can sign in and connect a key. The
          rest of the site runs without them: the record, the timeline and the proof panel are all
          live.
        </p>
        <p className="mt-6 font-mono text-[11px] tracking-[0.16em] text-dim uppercase">Still to set</p>
        <ul className="mt-3 flex flex-col gap-2 font-mono text-[12px] break-all text-ink/80">
          {missing.map((name) => (
            <li key={name} className="border-l border-amber/60 pl-4">
              {name}
            </li>
          ))}
        </ul>
        <p className="mt-8 text-[15px] leading-relaxed text-ink/60">
          They go in the environment of whoever runs this site. The names and what each one is for
          are in .env.example at the top of the repository.
        </p>
      </div>
    </main>
  );
}

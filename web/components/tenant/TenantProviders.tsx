"use client";

import { PrivyProvider } from "@privy-io/react-auth";

/**
 * Sign-in for the account area, in the same night palette as the rest of the site.
 *
 * No wallet is created for anybody: Privy is here to say who a trader is, nothing more.
 * The app id is public by design, and the secret that checks a token never leaves the
 * server.
 */
export function TenantProviders({ appId, children }: { appId: string; children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        appearance: {
          theme: "#0a0a0a",
          accentColor: "#ffb020",
          landingHeader: "Sign in to Kaaval",
          showWalletLoginFirst: false,
        },
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

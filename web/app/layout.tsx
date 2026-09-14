import type { Metadata } from "next";
import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { Footer } from "@/components/Footer";
import { GrainOverlay } from "@/components/GrainOverlay";
import { Nav } from "@/components/Nav";
import { SmoothScroll } from "@/components/SmoothScroll";
import { TickerStrip } from "@/components/TickerStrip";
import { dayMonth, utcHourMinute } from "@/lib/format";
import { getState, recordPaused } from "@/lib/record";
import { vidiyalUrl } from "@/lib/story";

const display = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["400", "800"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const body = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Kaaval, the night watch on Bitget",
  description:
    "Three brains trade tokenized US stocks on Bitget through the night under one rulebook. Every decision is written down and signed.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const state = await getState();
  const lastTickLabel =
    state.lastTickTs > 0
      ? `${utcHourMinute(state.lastTickTs)} UTC, ${dayMonth(state.lastTickTs)}`
      : null;

  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${display.variable} ${mono.variable} ${body.variable} h-full`}
    >
      <body className="min-h-full bg-ground text-ink">
        <SmoothScroll />
        <GrainOverlay />
        <Nav live={!recordPaused(state.lastTickTs)} lastTickLabel={lastTickLabel} />
        <TickerStrip />
        {children}
        <Footer sisterHref={vidiyalUrl()} />
      </body>
    </html>
  );
}

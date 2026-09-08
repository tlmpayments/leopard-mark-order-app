import { SignInWithLink } from "./SignInWithLink";

export const dynamic = "force-dynamic";

/**
 * The driver's personal link lands here.
 *
 * Signing in has to happen client-side: NextAuth's Credentials flow needs the
 * CSRF round trip and the Set-Cookie that `signIn()` performs in the browser.
 * The server component's only job is to pull the token out of the path and
 * hand it over — and to render something reassuring while it happens, because
 * this is the first thing a driver sees and a blank screen reads as broken.
 */
export default async function DriverLinkPage({ params }: PageProps<"/delivery/k/[token]">) {
  const { token } = await params;
  return <SignInWithLink token={token} />;
}

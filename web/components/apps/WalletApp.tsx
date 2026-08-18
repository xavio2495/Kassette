"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getAddress, isInstalled } from "@gemwallet/api";
import {
  XRPL_ADDRESS_RE,
  accountServerSnapshot,
  accountSnapshot,
  shortAccount,
  signIn,
  signOut,
  subscribeAccount,
} from "@/lib/account";
import { ErrorBox, Loading, useApi } from "@/components/ui";

// Wallet — the sign-up, such as it is.
//
// ⚠️ Nothing is created here and nothing is custodied. There is no seed field
// on this page and there never will be: Kassette's only authorization is the
// signature you put on an XRPL Payment yourself, one call at a time
// (HANDOFF.md §2.3). Signing in declares *which account you will sign with*, so
// tickets can be prefilled — and it shows you what Flare already knows about
// that account, all of it read live from Coston2 at request time.
//
// Which is also why "Sign out" is honest: it forgets a string in this browser.
// It cannot revoke anything, because nothing was ever granted.

interface SmartAccountInfo {
  xrplAccount: string;
  personalAccount: string;
  nonce: string;
  executor: string | null;
  operatorXrplAddress: string;
  coreVaultXrplAddress: string;
  lotSizeFxrp: number;
  fxrpAddress: string;
  masterAccountController: string;
  assetManager: string;
}

const EXPLORER = "https://coston2-explorer.flare.network/address";

function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="wallet-row">
      <div className="label">{label}</div>
      <div className="tnum" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, wordBreak: "break-all" }}>
        {children}
      </div>
      {note && <div style={{ color: "var(--faint)", fontSize: 11.5, lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}

export function WalletApp() {
  const account = useSyncExternalStore(subscribeAccount, accountSnapshot, accountServerSnapshot);
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);

  // `null` while unknown avoids offering a "connect" button for an extension that turns
  // out not to be there — the manual address field is the only true fallback either way.
  const [gemInstalled, setGemInstalled] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    isInstalled()
      .then((r) => setGemInstalled(r.result.isInstalled))
      .catch(() => setGemInstalled(false));
  }, []);

  async function connectGemWallet() {
    setConnecting(true);
    setConnectError(null);
    try {
      const res = await getAddress();
      const address = res.result?.address;
      if (!address || !signIn(address)) {
        setConnectError("GemWallet did not return a usable XRPL address.");
      }
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  const valid = XRPL_ADDRESS_RE.test(input.trim());
  const info = useApi<SmartAccountInfo>(
    account ? `/api/smart-account?xrpl=${encodeURIComponent(account)}` : null,
    [account]
  );

  return (
    <main className="mx-auto max-w-3xl px-6" style={{ padding: "clamp(26px, 4vw, 40px) 24px 56px" }}>
      <div className="label" style={{ marginBottom: 10 }}>{"// wallet"}</div>
      <h1 style={{ fontSize: "clamp(28px, 5vw, 44px)" }}>
        {account ? "You're signed in." : "Sign in with the account you'll sign from."}
      </h1>
      <p style={{ marginTop: 10, color: "var(--muted)", fontSize: 14, maxWidth: "62ch" }}>
        Kassette never holds a key. There is no seed field on this page and there never will be —
        the only authorization in this product is the signature you put on an XRPL Payment
        yourself, one call at a time. Signing in tells the ticket which account to build for.
      </p>

      {!account && gemInstalled && (
        <div style={{ marginTop: 20, maxWidth: 460 }}>
          <button type="button" className="btn btn-primary" style={{ width: "100%" }} disabled={connecting} onClick={connectGemWallet}>
            {connecting ? "connecting…" : "connect GemWallet"}
          </button>
          {connectError && <div style={{ marginTop: 8 }}><ErrorBox error={connectError} /></div>}
          <div className="label" style={{ marginTop: 16, marginBottom: 4, color: "var(--faint)" }}>
            or enter your address manually
          </div>
        </div>
      )}

      {!account && (
        <form
          className="wallet-form"
          style={gemInstalled ? { marginTop: 8 } : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (signIn(input)) setInput("");
          }}
        >
          <label className="label" htmlFor="xrpl-account" style={{ display: "block", marginBottom: 8 }}>
            your XRPL account
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              id="xrpl-account"
              className="field"
              style={{ flex: "1 1 320px", minWidth: 0, fontFamily: "var(--font-mono)" }}
              placeholder="r3eQYJuBAjAQFx5shpmC8MQnyigrjvzq1T"
              value={input}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setInput(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && input.length > 0 && !valid}
              aria-describedby="xrpl-account-help"
            />
            <button type="submit" className="btn btn-primary" disabled={!valid}>
              Sign in
            </button>
          </div>
          <p id="xrpl-account-help" style={{ marginTop: 8, color: "var(--faint)", fontSize: 11.5 }}>
            {touched && input.length > 0 && !valid
              ? "That is not an XRPL classic address — they start with r and are 25–35 characters."
              : "Your public classic address, starting with r. Nothing else is asked for, and nothing is sent anywhere."}
          </p>
        </form>
      )}

      {account && (
        <>
          <div className="wallet-id">
            <div>
              <div className="label">signed in as</div>
              <div className="tnum" style={{ fontFamily: "var(--font-mono)", fontSize: 15, marginTop: 4 }}>
                {account}
              </div>
            </div>
            <button type="button" className="btn" onClick={signOut}>
              Sign out
            </button>
          </div>
          <p style={{ color: "var(--faint)", fontSize: 11.5, marginTop: 8, maxWidth: "70ch" }}>
            Sign out forgets this address in this browser. It revokes nothing, because nothing was
            granted — there is no session, no allowance and no delegated signer to cancel.
          </p>

          <h2 style={{ fontSize: 20, margin: "36px 0 4px" }}>What Flare already knows</h2>
          <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16, maxWidth: "62ch" }}>
            Read live from Coston2 through <code>ContractRegistry</code> at the moment you asked —
            none of it is stored here and none of it is a constant.
          </p>

          {info.loading && !info.data && <Loading what="reading Coston2" />}
          {info.error && <ErrorBox error={info.error} />}

          {info.data && (
            <div className="wallet-facts">
              <Row
                label="personal account (Flare)"
                note="Derived from your XRPL address by MasterAccountController. It exists whether or not you ever use it — deriving it costs nothing and creates nothing."
              >
                <a className="link" href={`${EXPLORER}/${info.data.personalAccount}`} target="_blank" rel="noreferrer">
                  {info.data.personalAccount} ↗
                </a>
              </Row>
              <Row
                label="next nonce"
                note="Every instruction is bound to this number. A plan built against a stale nonce does not bounce — it strands the payment, which is why the ticket rebuilds one per trade."
              >
                {info.data.nonce}
              </Row>
              <Row
                label="executor"
                note={
                  info.data.executor
                    ? "An executor is registered for this account."
                    : "No executor — this build uses the inline 0xFF instruction, so none is needed."
                }
              >
                {info.data.executor ?? "none"}
              </Row>
              <Row label="operator XRPL wallet" note="Where a copy/fade Payment is addressed.">
                {info.data.operatorXrplAddress}
              </Row>
              <Row
                label="FXRP lot size"
                note="Redemption is lot-granular. Read per request — a stale constant would round a fade down without telling you."
              >
                {info.data.lotSizeFxrp} FXRP
              </Row>
              <Row label="FXRP asset">
                <a className="link" href={`${EXPLORER}/${info.data.fxrpAddress}`} target="_blank" rel="noreferrer">
                  {info.data.fxrpAddress} ↗
                </a>
              </Row>
            </div>
          )}
        </>
      )}

      <div className="wallet-note">
        <strong style={{ fontWeight: 600 }}>Coston2 testnet only.</strong> This build never touches
        mainnet or real funds. You need test XRP on the XRPL testnet to sign anything — the ticket
        tells you the exact amount before you sign, and you sign it in your own wallet, not here.
      </div>
    </main>
  );
}

export { shortAccount };

import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { ApiError } from "../api/client";
import type { ChoosableStorage, S3Form as S3Values, StorageOption, StorageProviderName } from "../api/types";
import { AppShell } from "../components/AppShell";
import { useAuth } from "../auth/AuthProvider";
import { usePlatformOwner } from "../api/PlatformOwnerProvider";
import { describeConnectError } from "./integrationMessages";
import { S3Form } from "./S3Form";

type Banner = { kind: "success" | "error"; text: string; /** Offered to the installation owner when Google isn't set up yet. */ settingsLink?: boolean };

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

const NAME: Record<StorageProviderName, string> = {
  google_drive: "Google Drive",
  local: "This server's disk",
  s3: "S3-compatible storage",
  sharepoint: "SharePoint",
};

const BLURB: Record<StorageProviderName, string> = {
  google_drive: "Files go to your own Google Drive. People upload straight from their browser to Google.",
  local: "Files are kept in a folder on the server this portal runs on. Choose this if you run the portal on your own server and want the evidence to stay there.",
  s3: "Files go to a bucket on Amazon S3, or on any service that works the same way: MinIO, Wasabi, Backblaze B2, Cloudflare R2, Ceph and others.",
  sharepoint: "Files go to a SharePoint document library.",
};

/** How each storage reads in a sentence: "kept <in Google Drive>", "switching to <Google Drive>". */
const KEPT: Record<ChoosableStorage, string> = { google_drive: "in Google Drive", local: "on this server's disk", s3: "in your S3 bucket" };
const SWITCH_TO: Record<ChoosableStorage, string> = { google_drive: "Google Drive", local: "this server's disk", s3: "S3 storage" };

/** What the evidence folders section says, and what to do first, for each storage. */
const FOLDERS: Record<ChoosableStorage, { where: string; explain: string; button: string; connectFirst: string }> = {
  google_drive: {
    where: "Google Drive",
    explain: "Each tenant needs its own top-level folder in your Drive. The portal creates it for you, because it can only see folders it created itself.",
    button: "Create folder in Google Drive",
    connectFirst: "Connect Google Drive first",
  },
  local: {
    where: "this server's disk",
    explain: "Each tenant gets its own folder inside your organisation's folder on this server. The portal creates it for you.",
    button: "Create folder on this server's disk",
    connectFirst: "Switch on this server's disk first",
  },
  s3: {
    where: "the S3 bucket",
    explain: "Each tenant gets its own folder in your bucket. The portal creates it for you.",
    button: "Create folder in the S3 bucket",
    connectFirst: "Set up S3 storage first",
  },
};

export interface IntegrationsPageProps {
  /** Sends the browser to Google's consent screen. Injectable so tests don't have to navigate for real. */
  redirect?: (url: string) => void;
}

export function IntegrationsPage(props: IntegrationsPageProps) {
  const { user } = useAuth();
  if (user?.role !== "org_admin") {
    return (
      <AppShell>
        <div className="p-8 max-w-3xl">
          <h1 className="text-xl font-semibold mb-2">Integrations</h1>
          <p className="text-sm text-gray-600">Only an org admin can connect or change storage. Ask one of your org's admins if something needs setting up.</p>
        </div>
      </AppShell>
    );
  }
  return <IntegrationsContent {...props} />;
}

function IntegrationsContent({ redirect = (url) => window.location.assign(url) }: IntegrationsPageProps) {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const storage = useApiQuery((signal) => api.getStorageOptions(signal), []);
  const tenants = useApiQuery((signal) => api.listTenants(signal), []);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showS3, setShowS3] = useState(false);
  /** A switch that is waiting for the person to confirm it, because it clears the tenants' folders. */
  const [pending, setPending] = useState<{ provider: ChoosableStorage; run: () => Promise<void> } | null>(null);
  const isOwner = usePlatformOwner() === true;

  // The server's OAuth callback sends the browser back here with ?connected=… or ?error=…. That is a
  // full page load, so what was fetched on mount is already up to date — no refetch needed.
  // Turn the parameter into a message once, then clear it from the address so a refresh doesn't repeat it.
  const connectedParam = params.get("connected");
  const errorParam = params.get("error");
  useEffect(() => {
    if (!connectedParam && !errorParam) return;
    if (connectedParam === "google_drive") {
      setBanner({ kind: "success", text: "Google Drive is connected. Next, create an evidence folder for each tenant below." });
    } else if (errorParam) {
      setBanner({ kind: "error", text: describeConnectError(errorParam), settingsLink: errorParam === "not_configured" });
    }
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedParam, errorParam]);

  const info = storage.data;
  const optionOf = (p: StorageProviderName) => info?.options.find((o) => o.provider === p);
  const current = info?.current;
  const locked = info?.locked === true;
  const currentOption = current ? optionOf(current) : undefined;
  const currentReady = currentOption?.connected === true && currentOption.status === "active";
  const folderText = current && current !== "sharepoint" ? FOLDERS[current] : FOLDERS.google_drive;
  const foldersToClear = (tenants.data ?? []).filter((t) => t.storageRootId).length;

  /** Runs something that changes the setup, shows what happened, and reloads what the page shows. */
  async function perform(key: string, action: () => Promise<string>, fallback: string) {
    setBanner(null);
    setPending(null);
    setBusy(key);
    try {
      const text = await action();
      setBanner({ kind: "success", text });
      storage.refetch();
      tenants.refetch();
    } catch (e) {
      setBanner({ kind: "error", text: errorText(e, fallback) });
    } finally {
      setBusy(null);
    }
  }

  /** Switching to a different storage clears the tenants' folders, so when some exist the person is asked first. */
  function switchTo(provider: ChoosableStorage, run: () => Promise<void>) {
    if (current !== provider && foldersToClear > 0) setPending({ provider, run });
    else void run();
  }

  async function connectDrive() {
    setBanner(null);
    setBusy("drive");
    try {
      const { url } = await api.startGoogleConnect();
      redirect(url);
    } catch (e) {
      setBusy(null);
      setBanner({ kind: "error", text: errorText(e, "Couldn't start the connection. Please try again."), settingsLink: e instanceof ApiError && e.code === "OAUTH_NOT_CONFIGURED" });
    }
  }

  const switchToConnected = (provider: ChoosableStorage) => () => switchTo(provider, () => perform(`use-${provider}`, async () => {
    await api.chooseStorageProvider(provider);
    return `Evidence will now be kept ${KEPT[provider]}. Next, create an evidence folder for each tenant below.`;
  }, "Couldn't switch the storage. Please try again."));

  const switchToLocal = () => switchTo("local", () => perform("local", async () => {
    const r = await api.connectLocalStorage();
    const where = isOwner ? ` (the folder is ${r.folder})` : "";
    return `Evidence will now be kept on this server's disk${where}. Next, create an evidence folder for each tenant below.`;
  }, "Couldn't switch on the server's disk. Please try again."));

  const testS3 = async (form: S3Values) => { await api.testS3Storage(form); };

  /** Returns true once saved, false when the person is first being asked to confirm. A failure is thrown, to be shown beside the form. */
  const saveS3 = async (form: S3Values): Promise<boolean> => {
    const saved = (r: { label: string }) => `S3 storage is connected: ${r.label}. Next, create an evidence folder for each tenant below.`;
    if (current !== "s3" && foldersToClear > 0) {
      setBanner(null);
      setPending({ provider: "s3", run: () => perform("s3", async () => { const r = await api.connectS3Storage(form); setShowS3(false); return saved(r); }, "Couldn't connect the S3 storage. Please try again.") });
      return false;
    }
    setBanner(null);
    setBusy("s3");
    try {
      const r = await api.connectS3Storage(form);
      setShowS3(false);
      setBanner({ kind: "success", text: saved(r) });
      storage.refetch();
      tenants.refetch();
      return true;
    } finally {
      setBusy(null);
    }
  };

  async function createFolder(tenantId: string) {
    setBanner(null);
    setBusy(`folder-${tenantId}`);
    try {
      await api.createTenantStorageRoot(tenantId);
      tenants.refetch();
    } catch (e) {
      setBanner({ kind: "error", text: errorText(e, "Couldn't create the folder. Please try again.") });
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null;

  return (
    <AppShell>
      <div className="p-8 max-w-3xl space-y-8">
        <header>
          <h1 className="text-xl font-semibold mb-1">Integrations</h1>
          <p className="text-sm text-gray-500">
            Evidence files are kept in storage that you control. This portal keeps only a record of each file (its name, size and checksum), never a copy of the file somewhere else.
          </p>
        </header>

        {banner && (
          <p role={banner.kind === "error" ? "alert" : "status"} className={`sticky top-2 z-10 rounded-lg px-3 py-2 text-sm shadow-sm ${banner.kind === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-800"}`}>
            {banner.text}
            {banner.settingsLink && isOwner && <> <Link to="/settings/server" className="underline font-semibold">Open Server settings</Link></>}
          </p>
        )}

        <section aria-labelledby="where-heading" className="space-y-3">
          <div>
            <h2 id="where-heading" className="font-semibold">Where evidence is kept</h2>
            {locked && current && (
              <p role="note" className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Evidence has already been uploaded {current !== "sharepoint" ? KEPT[current] : "to SharePoint"}, so this can't be changed any more: a recorded file only means something in the storage it was put in.
              </p>
            )}
            {!locked && <p className="text-sm text-gray-500 mt-1">Choose one. You can switch until the first evidence file is uploaded; after that the choice is fixed.</p>}
          </div>

          {storage.loading && !info && <p className="text-sm text-gray-500">Checking connection…</p>}
          {storage.error && <p className="text-sm text-red-600">{storage.error}</p>}

          {info && (
            <div className="space-y-3">
              <ProviderCard provider="google_drive" option={optionOf("google_drive")} current={current} locked={locked}>
                {(opt, usable) => (
                  <>
                    <p className="text-sm mb-3" data-testid="drive-status">
                      {!opt?.connected && "Not connected."}
                      {opt?.connected && opt.status === "active" && <>Connected{opt.label ? <> as <strong>{opt.label}</strong></> : null}.</>}
                      {opt?.connected && opt.status !== "active" && "Access was lost. Reconnect to let people upload evidence again."}
                    </p>
                    {usable && (
                      <div className="flex flex-wrap gap-2">
                        <button onClick={connectDrive} disabled={working} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
                          {busy === "drive" ? "Opening Google…" : opt?.connected ? "Reconnect Google Drive" : "Connect Google Drive"}
                        </button>
                        {opt?.connected && opt.status === "active" && current !== "google_drive" && (
                          <UseButton name="Google Drive" onClick={switchToConnected("google_drive")} disabled={working} busy={busy === "use-google_drive"} />
                        )}
                      </div>
                    )}
                    {!opt?.available && <Unavailable option={opt} isOwner={isOwner} link="/settings/server" />}
                  </>
                )}
              </ProviderCard>

              <ProviderCard provider="local" option={optionOf("local")} current={current} locked={locked}>
                {(opt, usable) => (
                  <>
                    <p className="text-sm mb-3" data-testid="local-status">
                      {!opt?.connected && "Not switched on."}
                      {opt?.connected && opt.status === "active" && "Switched on."}
                      {opt?.connected && opt.status !== "active" && "Needs to be switched on again."}
                    </p>
                    {usable && !(current === "local" && opt?.connected && opt.status === "active") && (
                      <UseButton name="this server's disk" onClick={switchToLocal} disabled={working} busy={busy === "local"} />
                    )}
                    {!opt?.available && <Unavailable option={opt} isOwner={isOwner} />}
                  </>
                )}
              </ProviderCard>

              <ProviderCard provider="s3" option={optionOf("s3")} current={current} locked={locked}>
                {(opt, usable) => (
                  <>
                    <p className="text-sm mb-3" data-testid="s3-status">
                      {!opt?.connected && "Not connected."}
                      {opt?.connected && opt.status === "active" && <>Connected{opt.label ? <> to <strong>{opt.label}</strong></> : null}.</>}
                      {opt?.connected && opt.status !== "active" && "Access was lost. Enter the details again."}
                    </p>
                    {usable && (
                      <div className="flex flex-wrap gap-2">
                        {opt?.connected && opt.status === "active" && current !== "s3" && (
                          <UseButton name="S3-compatible storage" onClick={switchToConnected("s3")} disabled={working} busy={busy === "use-s3"} />
                        )}
                        {!showS3 && (
                          <button onClick={() => setShowS3(true)} disabled={working} className="rounded-lg border border-teal-600 text-teal-700 px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
                            {opt?.connected ? (locked ? "Replace access keys" : "Change S3 settings") : "Set up S3-compatible storage"}
                          </button>
                        )}
                      </div>
                    )}
                    {usable && showS3 && (
                      <S3Form locked={locked && current === "s3"} onTest={testS3} onSave={saveS3} onCancel={() => setShowS3(false)} />
                    )}
                    {!opt?.available && <Unavailable option={opt} isOwner={isOwner} />}
                  </>
                )}
              </ProviderCard>

              <ProviderCard provider="sharepoint" option={optionOf("sharepoint")} current={current} locked={locked}>
                {(opt) => <Unavailable option={opt} isOwner={isOwner} />}
              </ProviderCard>
            </div>
          )}

          {pending && (
            <div role="alertdialog" aria-label="Confirm switching storage" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="mb-3">
                Switching to {SWITCH_TO[pending.provider]} clears the evidence {foldersToClear === 1 ? "folder" : "folders"} already set up for {foldersToClear} {foldersToClear === 1 ? "tenant" : "tenants"}, and you'll create new ones.
                No evidence has been uploaded yet, so nothing is lost.
              </p>
              <div className="flex gap-2">
                <button onClick={() => void pending.run()} disabled={working} className="rounded-lg bg-amber-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">Switch storage</button>
                <button onClick={() => setPending(null)} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm">Cancel</button>
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="folders-heading">
          <h2 id="folders-heading" className="font-semibold mb-1">Evidence folders</h2>
          <p className="text-sm text-gray-500 mb-3">{folderText.explain}</p>
          {tenants.error && <p className="text-sm text-red-600">{tenants.error}</p>}
          {tenants.data && tenants.data.length === 0 && <p className="text-sm text-gray-500">No tenants yet. Add one under Tenants first.</p>}
          <ul className="space-y-2">
            {(tenants.data ?? []).filter((t) => t.status === "active").map((t) => (
              <li key={t.id} className="rounded-lg border border-gray-200 bg-white p-3 flex items-center justify-between text-sm">
                <span>{t.name}</span>
                {t.storageRootId ? (
                  <span className="text-xs font-semibold text-green-700">Folder ready</span>
                ) : (
                  <button
                    onClick={() => createFolder(t.id)}
                    disabled={!currentReady || working}
                    title={currentReady ? undefined : folderText.connectFirst}
                    aria-label={`Create folder for ${t.name}`}
                    className="rounded-lg border border-teal-600 text-teal-700 px-3 py-1 text-xs font-semibold disabled:opacity-40 disabled:border-gray-300 disabled:text-gray-400"
                  >
                    {busy === `folder-${t.id}` ? "Creating…" : folderText.button}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

function UseButton({ name, onClick, disabled, busy }: { name: string; onClick: () => void; disabled: boolean; busy: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
      {busy ? "Switching…" : `Use ${name}`}
    </button>
  );
}

/** Why a storage can't be used here, in words for the person looking at it. */
function Unavailable({ option, isOwner, link }: { option: StorageOption | undefined; isOwner: boolean; link?: string }) {
  if (!option || option.available) return null;
  return (
    <p className="text-sm text-gray-600" data-testid={`${option.provider}-unavailable`}>
      {option.unavailableReason ?? "This isn't available on this server."}
      {link && isOwner && <> <Link to={link} className="underline font-semibold">Open Server settings</Link></>}
    </p>
  );
}

/**
 * One of the storages the person can choose. `usable` tells the content whether to offer its buttons: whether this
 * server offers the storage at all. Once the choice is locked, the other storages show no content (and so no buttons).
 */
function ProviderCard({ provider, option, current, locked, children }: {
  provider: StorageProviderName;
  option: StorageOption | undefined;
  current: StorageProviderName | undefined;
  locked: boolean;
  children: (option: StorageOption | undefined, usable: boolean) => ReactNode;
}) {
  const inUse = current === provider && option?.connected === true && option.status === "active";
  const usable = option?.available === true;
  const comingSoon = provider === "sharepoint";
  return (
    <section
      aria-labelledby={`${provider}-heading`}
      className={`rounded-xl border bg-white p-5 ${inUse ? "border-teal-500 ring-1 ring-teal-500" : "border-gray-200"} ${comingSoon || (locked && current !== provider) ? "opacity-70" : ""}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <h3 id={`${provider}-heading`} className="font-semibold">{NAME[provider]}</h3>
        {inUse && <span className="rounded-full bg-teal-600 px-2 py-0.5 text-[11px] font-semibold text-white">In use</span>}
        {comingSoon && <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-600">Coming later</span>}
      </div>
      <p className="text-sm text-gray-500 mb-3">{BLURB[provider]}</p>
      {locked && current !== provider && !comingSoon && (
        <p className="text-sm text-gray-500">Not available: the evidence is already kept somewhere else.</p>
      )}
      {(!locked || current === provider || comingSoon) && children(option, usable)}
    </section>
  );
}

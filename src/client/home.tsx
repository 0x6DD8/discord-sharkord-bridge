import { createCallAction, usePush } from "@sharkord/plugin-sdk/client";
import { memo, useCallback, useEffect, useState, type CSSProperties } from "react";
import type { TPlugin, TBridgeStatus } from "../types";

const callAction = createCallAction<TPlugin>();

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  padding: 16,
  color: "var(--foreground)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
};

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: "var(--radius)",
  background: "var(--primary)",
  color: "var(--primary-foreground)",
};

const badgeStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: 12,
  fontWeight: 600,
};

const Home = memo(() => {
  const [status, setStatus] = useState<TBridgeStatus>();

  usePush<TPlugin>((next) => setStatus(next));

  const refresh = useCallback(async () => {
    setStatus(await callAction("getStatus"));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connected = status?.connected ?? false;

  return (
    <div style={panelStyle}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Discord-Sharkord Bridge</h1>

      <div style={rowStyle}>
        <span
          style={{
            ...badgeStyle,
            background: connected ? "var(--primary)" : "var(--muted)",
            color: connected ? "var(--primary-foreground)" : "var(--muted-foreground)",
          }}
        >
          {connected ? "Connected" : "Disconnected"}
        </span>

        <span style={{ color: "var(--muted-foreground)" }}>
          {status?.discordUsername ?? "no Discord bot"}
        </span>
      </div>

      <span style={{ color: "var(--muted-foreground)" }}>
        {status && !status.configured
          ? "Set the Discord bot token and guild ID in this plugin's settings."
          : `${status?.bridgedChannels.length ?? 0} channel(s) bridged in guild ${status?.guildId || "(none)"}.`}
      </span>

      {status?.error ? (
        <span style={{ color: "var(--destructive, #ef4444)" }}>{status.error}</span>
      ) : null}

      <div style={rowStyle}>
        <button style={buttonStyle} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
    </div>
  );
});

export { Home };

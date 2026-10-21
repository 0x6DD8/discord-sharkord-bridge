export type TBridgeStatus = {
  configured: boolean;
  connected: boolean;
  guildId: string;
  discordUsername: string | null;
  bridgedChannels: string[];
  error?: string;
};


export type TPlugin = {
  actions: {
    getStatus: { payload: void; response: TBridgeStatus };
  };
  push: TBridgeStatus;
};

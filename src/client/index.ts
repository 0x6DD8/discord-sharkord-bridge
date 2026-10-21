import type { TPluginComponentsMapBySlotId } from "@sharkord/plugin-sdk/client";
import { Home } from "./home";
import { PluginSlot } from "@sharkord/plugin-sdk";

/**
 * Where this plugin's components render. A slot takes a list, so one plugin can
 * put several components in the same place.
 */
const components: TPluginComponentsMapBySlotId = {
  [PluginSlot.HOME_SCREEN]: [Home],
};

export { components };

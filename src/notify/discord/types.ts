import type { Client } from 'discord.js';
import type { NotifierOptions } from '../types.js';

// Constructor options for DiscordNotifier. `client` accepts an injected/mock client for tests.
export interface DiscordNotifierOptions extends NotifierOptions {
  client?: Client | any;
}

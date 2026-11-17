import type { Client } from 'discord.js';
import type { NotifierOptions } from '../types.js';

export interface DiscordNotifierOptions extends NotifierOptions {
  client?: Client | any;
}

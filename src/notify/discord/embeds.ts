import { EmbedBuilder } from 'discord.js';
import type { QuotaSnapshot, DispatchStatusUpdate } from '../types.js';
import { buildQuotaStatusEmbed, buildDispatchStatusEmbed } from '../embeds/index.js';
import type { StandardEmbed } from '../embeds/types.js';

/** Clamps the shared embed model to Discord's per-field limits. */
const toEmbed = (standard: StandardEmbed): EmbedBuilder => {
  const embed = new EmbedBuilder().setTitle(standard.title!).setColor(standard.color!);

  if (standard.description) {
    embed.setDescription(standard.description.slice(0, 4096));
  }

  if (standard.fields && standard.fields.length > 0) {
    embed.addFields(
      standard.fields.map((f) => ({
        name: f.name.slice(0, 256),
        value: f.value.slice(0, 1024),
        inline: f.inline ?? true,
      }))
    );
  }

  if (standard.url) {
    embed.setURL(standard.url);
  }

  if (standard.footer) {
    embed.setFooter({ text: standard.footer.text.slice(0, 2048) });
  }

  if (standard.timestamp) {
    embed.setTimestamp(new Date(standard.timestamp));
  }

  return embed;
};

/** Maps the shared quota-status embed model onto a Discord EmbedBuilder. */
export const renderQuotaEmbed = (pools: QuotaSnapshot[], baseUrl?: string): EmbedBuilder =>
  toEmbed(buildQuotaStatusEmbed(pools, { baseUrl }));

/** Maps the shared dispatch-status embed model onto a Discord EmbedBuilder. */
export const renderDispatchEmbed = (status: DispatchStatusUpdate, baseUrl?: string): EmbedBuilder =>
  toEmbed(buildDispatchStatusEmbed(status, { baseUrl }));

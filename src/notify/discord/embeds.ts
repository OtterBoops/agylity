import { EmbedBuilder } from 'discord.js';
import type { QuotaSnapshot, DispatchStatusUpdate } from '../types.js';
import { buildQuotaStatusEmbed, buildDispatchStatusEmbed } from '../embeds/index.js';

/** Maps the shared quota-status embed model onto a Discord EmbedBuilder. */
export const renderQuotaEmbed = (pools: QuotaSnapshot[]): EmbedBuilder => {
  const standard = buildQuotaStatusEmbed(pools);
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

  if (standard.footer) {
    embed.setFooter({ text: standard.footer.text.slice(0, 2048) });
  }

  if (standard.timestamp) {
    embed.setTimestamp(new Date(standard.timestamp));
  }

  return embed;
};

/** Maps the shared dispatch-status embed model onto a Discord EmbedBuilder, clamping field limits. */
export const renderDispatchEmbed = (status: DispatchStatusUpdate): EmbedBuilder => {
  const standard = buildDispatchStatusEmbed(status);
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

  if (standard.footer) {
    embed.setFooter({ text: standard.footer.text.slice(0, 2048) });
  }

  if (standard.timestamp) {
    embed.setTimestamp(new Date(standard.timestamp));
  }

  return embed;
};

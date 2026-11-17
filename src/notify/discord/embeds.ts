import { EmbedBuilder } from 'discord.js';
import type { QuotaSnapshot, DispatchStatusUpdate, InfoNotice } from '../types.js';
import {
  buildQuotaStatusEmbed,
  buildDispatchStatusEmbed,
  buildInfoNoticeEmbed,
} from '../embeds/index.js';
import type { StandardEmbed } from '../embeds/types.js';

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

export const renderQuotaEmbed = (pools: QuotaSnapshot[], baseUrl?: string): EmbedBuilder =>
  toEmbed(buildQuotaStatusEmbed(pools, { baseUrl }));

export const renderDispatchEmbed = (status: DispatchStatusUpdate, baseUrl?: string): EmbedBuilder =>
  toEmbed(buildDispatchStatusEmbed(status, { baseUrl }));

export const renderInfoEmbed = (notice: InfoNotice, baseUrl?: string): EmbedBuilder =>
  toEmbed(buildInfoNoticeEmbed(notice, { baseUrl }));

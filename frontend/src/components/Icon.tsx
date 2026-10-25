import type { IconDefinition } from '@fortawesome/free-solid-svg-icons';

export interface IconProps {
  icon: IconDefinition;
  class?: string;
  title?: string;
}

export const Icon = ({ icon, class: className = 'size-4', title }: IconProps) => {
  const [width, height, , , svgPath] = icon.icon;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      class={`inline-block shrink-0 fill-current ${className}`}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={svgPath as string} />
    </svg>
  );
};

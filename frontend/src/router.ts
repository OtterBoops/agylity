import { useEffect, useState } from 'preact/hooks';

export const ROUTES = [
  'overview',
  'logs',
  'settings/notifications',
  'settings/remote',
  'settings/repositories',
  'settings/advanced',
] as const;

export type Route = (typeof ROUTES)[number];

const parse = (): Route => {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(raw) ? (raw as Route) : 'overview';
};

export const useHashRoute = (): [Route, (r: Route) => void] => {
  const [route, setRoute] = useState<Route>(parse);

  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return [
    route,
    (r) => {
      window.location.hash = `/${r}`;
    },
  ];
};

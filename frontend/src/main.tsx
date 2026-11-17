import { render } from 'preact';
import '@fontsource-variable/inter/index.css';
import '@fontsource/space-mono/latin-400.css';
import '@fontsource/space-mono/latin-700.css';
import './index.css';
import { App } from './app.tsx';
import { invalidateClientCacheOnNewVersion } from './utils/cacheBuster.ts';

void invalidateClientCacheOnNewVersion();

render(<App />, document.getElementById('app')!);

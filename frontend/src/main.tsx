import { render } from 'preact';
import './index.css';
import { App } from './app.tsx';
import { invalidateClientCacheOnNewVersion } from './utils/cacheBuster.ts';

void invalidateClientCacheOnNewVersion();

render(<App />, document.getElementById('app')!);

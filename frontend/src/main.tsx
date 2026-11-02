import { render } from 'preact';
import './index.css';
import { App } from './app.tsx';
import { invalidateClientCacheOnNewVersion } from './utils/cacheBuster.ts';
import { normalizeStoredTheme, resolveEffectiveTheme, applyDocumentTheme } from './theme.ts';

void invalidateClientCacheOnNewVersion();

// Immediately apply theme and mobile status bar/navigation bar theme-color
const initialTheme = normalizeStoredTheme(localStorage.getItem('agylity-theme'));
applyDocumentTheme(resolveEffectiveTheme(initialTheme));

render(<App />, document.getElementById('app')!);

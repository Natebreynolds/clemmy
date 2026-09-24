import { createContext } from 'react';

/**
 * The name the top bar gives the current page. It is the one place a page is
 * named: a page heading that says the same word again is a repeat, so `Page`
 * leaves it out and keeps the subtitle and actions.
 */
export const ShellTitleContext = createContext<string>('');

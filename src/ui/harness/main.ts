import { mount } from 'svelte';
import { __setBrowserApi } from '../../browser/index.ts';
import '../styles/base.css';
import { createFakeBrowserApi } from './fake-browser.ts';
import Harness from './Harness.svelte';

// Must be installed before any component runs, so nothing reaches chrome.*.
__setBrowserApi(createFakeBrowserApi());

const target = document.getElementById('harness');
if (!target) throw new Error('harness root missing');

mount(Harness, { target });

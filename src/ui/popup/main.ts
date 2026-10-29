import { mount } from 'svelte';
import '../styles/base.css';
import { extensionBridge } from '../lib/bridge.ts';
import Popup from './Popup.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('popup root missing');

mount(Popup, { target, props: { bridge: extensionBridge } });

import { mount } from 'svelte';
import '../styles/base.css';
import Options from './Options.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('options root missing');

mount(Options, { target });

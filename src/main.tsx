import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// StrictMode is intentionally omitted: its dev-only double-invocation of effects
// would run each engine's benchmark twice and double-initialise WebGPU/workers on
// the same canvas, which is harmful for this reload-based isolated benchmark.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

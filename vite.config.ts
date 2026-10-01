import {defineConfig} from 'vite';
export default defineConfig({
 server:{host:'127.0.0.1',port:5173},
 // Relative assets, so the same build runs from a subdirectory of a static host (GitHub Pages serves the project at
 // /<repo>/) and from disk: an absolute /assets/... would ask the host's root and 404. There is no history router, so
 // nothing else needs a base.
 build:{target:'es2022'},base:'./',
});

# Supply workspace UI prototype

Throwaway prototype answering: which Apple-inspired, no-sidebar workspace structure best keeps Supply short while keeping Taiwan, Vietnam, and the single Subcontract vendor unmistakably separate?

Run from the prototype directory so no other repository files are served:

```sh
cd prototypes/supply-workspace
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/?variant=A`. Use the floating arrows or the keyboard left/right arrows to compare variants A, B, and C.

The data is synthetic and all interactions are in-memory. This prototype is not production code.

# Create a project which compares IFClite and ThatOpen

IFClite:
- https://louistrue.github.io/ifc-lite/
- https://github.com/louistrue/ifc-lite

ThatOpen:
- https://docs.thatopen.com/intro
- https://github.com/ThatOpen


## UI
At the top a kind of 'toolbar', which has a 'Browse' button at the left hand side, to allow selecting an IFC file using a standard file open dialog.
Next to that a space which shows the name of the selected IFC file.

Below the top 'toolbar' two areas (left IFClite area | right ThatOpen area).
Left and right area are split 50/50.
Both areas shall have the same layout.

The left area contains the IFClite viewer, taking up the most space.
Below the IFClite viewer should be an area (text box), which shows progress/stats/information.

The right area contains the That Open viewer, taking up the most space.
Below the That Open viewer should be an area (text box), which shows progress/stats/information.

```plaintext
+---------------------------------------------------------------------+
| [Browse]  Selected file: my_model.ifc                               |
+---------------------------------------------------------------------+
|+--------------------------------+|+--------------------------------+|
||                                |||                                ||
||        IFClite Viewer          |||        ThatOpen Viewer         ||
||        (zoom/pan/orbit)        |||        (zoom/pan/orbit)        ||
||                                |||                                ||
||                                |||                                ||
|+--------------------------------+|+--------------------------------+|
|| IFClite stats / logs /         ||| ThatOpen stats / logs /        ||
|| progress text box              ||| progress text box              ||
|+--------------------------------+|+--------------------------------+|
+---------------------------------------------------------------------+
```

## Functionality
The user selects an IFC file.
When a file is selected, both viewers:
- reset
- start parsing *simultaneously*
- display progress in real time

Measure and show some statistics:
- speed of parsing
- speed of rendering
- statistics (count, size, ...) about the files which were created in the background (fragment, parquet, ...)
- the viewer should provide all standard functionality which you would expect from a BIM viewer:
  - zoom, pan, orbit, reset view (default isometric view), object tree, property window
  
## Architecture
Both viewers must use comparable technologies:
- client-side only parsing using WASM
- no backend pipeline
- store the parsed files on disk
- react frontend

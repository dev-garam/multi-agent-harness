# Expected fix (grading reference, not given to the agent)

The bug is in `captureOutput()`, not in the parser.

`trim()` strips the leading space of the FIRST line only, so " M README.md"
becomes "M README.md" and the fixed-width parser reads the path one character
late ("EADME.md"). Lines 2+ keep their leading space and parse correctly.

Correct fix: stop destroying the leading space.

    return String(rawStdout || '').trim();      // wrong
    return String(rawStdout || '').trimEnd();   // correct

Difficulty: hard, and deliberately so.

The symptom appears in the parser but the cause is in the capture step. The
tempting fix -- changing `slice(3)` to `slice(2)` -- makes line 1 pass and
breaks lines 2-4, so the test suite rejects it. An agent that pattern-matches on
the symptom cannot pass; it has to trace the data back to where the leading
space was lost.

This is a real bug found in this harness (src/inspection.js). A supervisor agent
correctly spotted the symptom and then proposed exactly the wrong fix
(slice(3) -> slice(2)).

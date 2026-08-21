# Expected fix (grading reference, not given to the agent)

`median()` averages the wrong pair for even-length input.

    sorted[middle] + sorted[middle + 1]   // wrong: reads past the midpoint
    sorted[middle - 1] + sorted[middle]   // correct

Difficulty: easy. The failing assertion names the exact value, the function is
small and self-contained, and `percentile()` right below it already shows the
correct clamping idiom.

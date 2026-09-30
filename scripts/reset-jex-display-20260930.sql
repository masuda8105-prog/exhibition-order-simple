-- One-time operator-approved reset for the SIMPLE/JEX pickup counter.
-- Keep the globally unique internal number and all existing order rows intact.
-- The application displays generation 5+ as JEX-<run number>, knowingly
-- allowing a paper-label collision with earlier generations.
-- The generation predicate prevents an accidental second execution.
update simple_order_private.pickup_counter
set generation = generation + 1,
    run_last_number = 0
where singleton = true
  and generation = 4
returning generation, last_number, run_last_number;

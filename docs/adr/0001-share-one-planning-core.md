# Share one planning core across public and Boss entrypoints

The public and Boss pages will import the same pure planning, snapshot, velocity-risk, and order-draft modules, while authentication and persistence remain thin entrypoint adapters. This avoids maintaining duplicated business logic without forcing a framework rewrite or mixing Boss-only cloud behavior into the public workspace.

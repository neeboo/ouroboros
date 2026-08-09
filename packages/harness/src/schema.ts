export const EVOLUTION_ACTION_RECEIPTS_SCHEMA_SQL = `
  create unique index if not exists idx_runs_project_id_unique
    on runs(project_id, id);
  create unique index if not exists idx_production_episodes_project_id_unique
    on production_episodes(project_id, id);
  create unique index if not exists idx_harness_variants_project_id_unique
    on harness_variants(project_id, id);
  create unique index if not exists idx_matched_experiments_project_id_unique
    on matched_experiments(project_id, id);

  create table if not exists evolution_action_receipts (
    action_event_id text primary key references harness_action_events(id) on delete restrict,
    action_type text not null check (
      action_type in (
        'registerEvolutionProfile',
        'recordProductionEpisode',
        'registerHarnessVariant',
        'freezeMatchedExperiment'
      )
    ),
    source_run_id text not null,
    project_id text not null,
    record_kind text not null check (record_kind in ('profile','episode','variant','experiment')),
    record_id text not null,
    record_sha256 text not null check (
      length(record_sha256) = 64
      and record_sha256 not glob '*[^0-9a-f]*'
    ),
    profile_id text,
    episode_id text,
    variant_id text,
    experiment_id text,
    created_at text not null default current_timestamp,
    foreign key (project_id, source_run_id) references runs(project_id, id) on delete restrict,
    foreign key (project_id, profile_id) references evolution_profiles(project_id, id) on delete restrict,
    foreign key (project_id, episode_id) references production_episodes(project_id, id) on delete restrict,
    foreign key (project_id, variant_id) references harness_variants(project_id, id) on delete restrict,
    foreign key (project_id, experiment_id) references matched_experiments(project_id, id) on delete restrict,
    check (
      (record_kind = 'profile' and action_type = 'registerEvolutionProfile'
        and profile_id = record_id and episode_id is null and variant_id is null and experiment_id is null)
      or
      (record_kind = 'episode' and action_type = 'recordProductionEpisode'
        and profile_id is null and episode_id = record_id and variant_id is null and experiment_id is null)
      or
      (record_kind = 'variant' and action_type = 'registerHarnessVariant'
        and profile_id is null and episode_id is null and variant_id = record_id and experiment_id is null)
      or
      (record_kind = 'experiment' and action_type = 'freezeMatchedExperiment'
        and profile_id is null and episode_id is null and variant_id is null and experiment_id = record_id)
    )
  );

  create index if not exists idx_evolution_action_receipts_record
    on evolution_action_receipts(project_id, record_kind, record_id, created_at, action_event_id);
  create index if not exists idx_evolution_action_receipts_run
    on evolution_action_receipts(source_run_id, created_at, action_event_id);

  create trigger if not exists prevent_evolution_action_receipts_update
  before update on evolution_action_receipts begin
    select raise(abort, 'evolution_action_receipts are immutable');
  end;
  create trigger if not exists prevent_evolution_action_receipts_delete
  before delete on evolution_action_receipts begin
    select raise(abort, 'evolution_action_receipts are immutable');
  end;
  create trigger if not exists prevent_linked_evolution_action_event_update
  before update on harness_action_events
  when exists (
    select 1 from evolution_action_receipts where action_event_id = old.id
  ) begin
    select raise(abort, 'linked evolution harness_action_events are immutable');
  end;
  create trigger if not exists prevent_linked_evolution_action_event_delete
  before delete on harness_action_events
  when exists (
    select 1 from evolution_action_receipts where action_event_id = old.id
  ) begin
    select raise(abort, 'linked evolution harness_action_events are immutable');
  end;
`;

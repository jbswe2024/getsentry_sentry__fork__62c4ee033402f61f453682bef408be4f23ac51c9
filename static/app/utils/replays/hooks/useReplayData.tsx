import {useCallback, useEffect, useMemo, useState} from 'react';
import * as Sentry from '@sentry/react';

import type {Client} from 'sentry/api';
import {ALL_ACCESS_PROJECTS} from 'sentry/constants/pageFilters';
import useFetchParallelPages from 'sentry/utils/api/useFetchParallelPages';
import type {ParsedHeader} from 'sentry/utils/parseLinkHeader';
import parseLinkHeader from 'sentry/utils/parseLinkHeader';
import type {ApiQueryKey} from 'sentry/utils/queryClient';
import {useApiQuery, useQueryClient} from 'sentry/utils/queryClient';
import {mapResponseToReplayRecord} from 'sentry/utils/replays/replayDataUtils';
import type RequestError from 'sentry/utils/requestError/requestError';
import useApi from 'sentry/utils/useApi';
import useProjects from 'sentry/utils/useProjects';
import type {ReplayError, ReplayRecord} from 'sentry/views/replays/types';

type State = {
  /**
   * If any request returned an error then nothing is being returned
   */
  fetchError: undefined | RequestError;

  /**
   * If a fetch is underway for the requested root reply.
   * This includes fetched all the sub-resources like attachments and `sentry-replay-event`
   */
  fetchingAttachments: boolean;
  fetchingErrors: boolean;
};

type Options = {
  /**
   * The organization slug
   */
  orgSlug: string;

  /**
   * The replayId
   */
  replayId: string;

  /**
   * Default: 50
   * You can override this for testing
   */
  errorsPerPage?: number;

  /**
   * Default: 100
   * You can override this for testing
   */
  segmentsPerPage?: number;
};

interface Result {
  attachments: unknown[];
  errors: ReplayError[];
  fetchError: undefined | RequestError;
  fetching: boolean;
  onRetry: () => void;
  projectSlug: string | null;
  replayRecord: ReplayRecord | undefined;
}

const INITIAL_STATE: State = Object.freeze({
  fetchError: undefined,
  fetchingAttachments: true,
  fetchingErrors: true,
});

/**
 * A react hook to load core replay data over the network.
 *
 * Core replay data includes:
 * 1. The root replay EventTransaction object
 *    - This includes `startTimestamp`, and `tags`
 * 2. RRWeb, Breadcrumb, and Span attachment data
 *    - We make an API call to get a list of segments, each segment contains a
 *      list of attachments
 *    - There may be a few large segments, or many small segments. It depends!
 *      ie: If the replay has many events/errors then there will be many small segments,
 *      or if the page changes rapidly across each pageload, then there will be
 *      larger segments, but potentially fewer of them.
 * 3. Related Event data
 *    - Event details are not part of the attachments payload, so we have to
 *      request them separately
 *
 * This function should stay focused on loading data over the network.
 * Front-end processing, filtering and re-mixing of the different data streams
 * must be delegated to the `ReplayReader` class.
 *
 * @param {orgSlug, replayId} Where to find the root replay event
 * @returns An object representing a unified result of the network requests. Either a single `ReplayReader` data object or fetch errors.
 */
function useReplayData({
  replayId,
  orgSlug,
  errorsPerPage = 50,
  segmentsPerPage = 100,
}: Options): Result {
  const projects = useProjects();

  const api = useApi();
  const queryClient = useQueryClient();

  const [state, setState] = useState<State>(INITIAL_STATE);
  const [errors, setErrors] = useState<ReplayError[]>([]);

  // Fetch every field of the replay. The TS type definition lists every field
  // that's available. It's easier to ask for them all and not have to deal with
  // partial types or nullable fields.
  // We're overfetching for sure.
  const {
    data: replayData,
    isFetching: isFetchingReplay,
    error: fetchReplayError,
  } = useApiQuery<{data: unknown}>([`/organizations/${orgSlug}/replays/${replayId}/`], {
    staleTime: Infinity,
  });
  const replayRecord = useMemo(
    () => (replayData?.data ? mapResponseToReplayRecord(replayData.data) : undefined),
    [replayData?.data]
  );

  const projectSlug = useMemo(() => {
    if (!replayRecord) {
      return null;
    }
    return projects.projects.find(p => p.id === replayRecord.project_id)?.slug ?? null;
  }, [replayRecord, projects.projects]);

  const getAttachmentsQueryKey = useCallback(
    ({cursor, per_page}): ApiQueryKey => {
      return [
        `/projects/${orgSlug}/${projectSlug}/replays/${replayId}/recording-segments/`,
        {
          query: {
            download: true,
            per_page,
            cursor,
          },
        },
      ];
    },
    [orgSlug, projectSlug, replayId]
  );

  const {pages: attachmentPages, isFetching: isFetchingAttachments} =
    useFetchParallelPages({
      enabled: !fetchReplayError && Boolean(projectSlug) && Boolean(replayRecord),
      hits: replayRecord?.count_segments ?? 0,
      getQueryKey: getAttachmentsQueryKey,
      perPage: segmentsPerPage,
    });

  const fetchErrors = useCallback(async () => {
    if (!replayRecord) {
      return;
    }

    // Clone the `finished_at` time and bump it up one second because finishedAt
    // has the `ms` portion truncated, while replays-events-meta operates on
    // timestamps with `ms` attached. So finishedAt could be at time `12:00:00.000Z`
    // while the event is saved with `12:00:00.450Z`.
    const finishedAtClone = new Date(replayRecord.finished_at);
    finishedAtClone.setSeconds(finishedAtClone.getSeconds() + 1);

    const paginatedErrors = fetchPaginatedReplayErrors(api, {
      orgSlug,
      replayId: replayRecord.id,
      start: replayRecord.started_at,
      end: finishedAtClone,
      limit: errorsPerPage,
    });

    for await (const pagedResults of paginatedErrors) {
      setErrors(prev => [...prev, ...(pagedResults || [])]);
    }

    setState(prev => ({...prev, fetchingErrors: false}));
  }, [api, orgSlug, replayRecord, errorsPerPage]);

  const onError = useCallback(err => {
    Sentry.captureException(err);
    setState(prev => ({...prev, fetchError: err}));
  }, []);

  useEffect(() => {
    if (state.fetchError) {
      return;
    }
    fetchErrors().catch(onError);
  }, [state.fetchError, fetchErrors, onError]);

  const clearQueryCache = useCallback(() => {
    () => {
      queryClient.invalidateQueries({
        queryKey: [`/organizations/${orgSlug}/replays/${replayId}/`],
      });
      queryClient.invalidateQueries({
        queryKey: [
          `/projects/${orgSlug}/${projectSlug}/replays/${replayId}/recording-segments/`,
        ],
      });
      // The next one isn't optimized
      // This statement will invalidate the cache of fetched error events for replayIds
      queryClient.invalidateQueries({
        queryKey: [`/organizations/${orgSlug}/replays-events-meta/`],
      });
    };
  }, [orgSlug, replayId, projectSlug, queryClient]);

  return {
    attachments: attachmentPages.flat(2),
    errors,
    fetchError: fetchReplayError ?? state.fetchError,
    fetching: state.fetchingErrors || isFetchingReplay || isFetchingAttachments,
    projectSlug,
    onRetry: clearQueryCache,
    replayRecord,
  };
}

async function fetchReplayErrors(
  api: Client,
  {
    orgSlug,
    start,
    end,
    replayId,
    limit = 50,
    cursor = '0:0:0',
  }: {
    end: Date;
    orgSlug: string;
    replayId: string;
    start: Date;
    cursor?: string;
    limit?: number;
  }
) {
  return await api.requestPromise(`/organizations/${orgSlug}/replays-events-meta/`, {
    includeAllArgs: true,
    query: {
      start: start.toISOString(),
      end: end.toISOString(),
      query: `replayId:[${replayId}]`,
      per_page: limit,
      cursor,
      project: ALL_ACCESS_PROJECTS,
    },
  });
}

async function* fetchPaginatedReplayErrors(
  api: Client,
  {
    orgSlug,
    start,
    end,
    replayId,
    limit = 50,
  }: {
    end: Date;
    orgSlug: string;
    replayId: string;
    start: Date;
    limit?: number;
  }
): AsyncGenerator<ReplayError[]> {
  function next(nextCursor: string) {
    return fetchReplayErrors(api, {
      orgSlug,
      replayId,
      start,
      end,
      limit,
      cursor: nextCursor,
    });
  }
  let cursor: undefined | ParsedHeader = {
    cursor: '0:0:0',
    results: true,
    href: '',
  };
  while (cursor && cursor.results) {
    const [{data}, , resp] = await next(cursor.cursor);
    const pageLinks = resp?.getResponseHeader('Link') ?? null;
    cursor = parseLinkHeader(pageLinks)?.next;
    yield data;
  }
}

export default useReplayData;

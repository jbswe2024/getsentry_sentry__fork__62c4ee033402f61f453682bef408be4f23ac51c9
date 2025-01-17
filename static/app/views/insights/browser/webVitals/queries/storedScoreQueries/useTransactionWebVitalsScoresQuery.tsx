import {useDiscoverQuery} from 'sentry/utils/discover/discoverQuery';
import EventView from 'sentry/utils/discover/eventView';
import type {Sort} from 'sentry/utils/discover/fields';
import {DiscoverDatasets} from 'sentry/utils/discover/types';
import {MutableSearch} from 'sentry/utils/tokenizeSearch';
import {useLocation} from 'sentry/utils/useLocation';
import useOrganization from 'sentry/utils/useOrganization';
import usePageFilters from 'sentry/utils/usePageFilters';
import {calculatePerformanceScoreFromStoredTableDataRow} from 'sentry/views/insights/browser/webVitals/queries/storedScoreQueries/calculatePerformanceScoreFromStored';
import {DEFAULT_QUERY_FILTER} from 'sentry/views/insights/browser/webVitals/settings';
import type {
  RowWithScoreAndOpportunity,
  WebVitals,
} from 'sentry/views/insights/browser/webVitals/types';
import type {BrowserType} from 'sentry/views/insights/browser/webVitals/utils/queryParameterDecoders/browserType';
import {useStaticWeightsSetting} from 'sentry/views/insights/browser/webVitals/utils/useStaticWeightsSetting';
import {useWebVitalsSort} from 'sentry/views/insights/browser/webVitals/utils/useWebVitalsSort';
import {SpanIndexedField} from 'sentry/views/insights/types';

type Props = {
  browserTypes?: BrowserType[];
  defaultSort?: Sort;
  enabled?: boolean;
  limit?: number;
  query?: string;
  shouldEscapeFilters?: boolean;
  sortName?: string;
  transaction?: string | null;
  webVital?: WebVitals | 'total';
};

export const useTransactionWebVitalsScoresQuery = ({
  limit,
  transaction,
  defaultSort,
  sortName = 'sort',
  enabled = true,
  webVital = 'total',
  query,
  shouldEscapeFilters = true,
  browserTypes,
}: Props) => {
  const organization = useOrganization();
  const pageFilters = usePageFilters();
  const location = useLocation();
  const shouldUseStaticWeights = useStaticWeightsSetting();

  const sort = useWebVitalsSort({sortName, defaultSort});
  if (sort !== undefined && shouldUseStaticWeights) {
    if (sort.field === 'avg(measurements.score.total)') {
      sort.field = 'performance_score(measurements.score.total)';
    }
    if (sort.field === 'opportunity_score(measurements.score.total)') {
      sort.field = 'total_opportunity_score()';
    }
  }

  const search = new MutableSearch([
    'avg(measurements.score.total):>=0',
    ...(query ? [query] : []),
  ]);
  if (transaction) {
    search.addFilterValue('transaction', transaction, shouldEscapeFilters);
  }
  if (browserTypes) {
    search.addDisjunctionFilterValues(SpanIndexedField.BROWSER_NAME, browserTypes);
  }
  const eventView = EventView.fromNewQueryWithPageFilters(
    {
      fields: [
        'transaction',
        'p75(measurements.lcp)',
        'p75(measurements.fcp)',
        'p75(measurements.cls)',
        'p75(measurements.ttfb)',
        'p75(measurements.inp)',
        ...(webVital !== 'total'
          ? [`performance_score(measurements.score.${webVital})`]
          : []),
        `opportunity_score(measurements.score.${webVital})`,
        ...(shouldUseStaticWeights
          ? ['performance_score(measurements.score.total)']
          : ['avg(measurements.score.total)']),
        'count()',
        `count_scores(measurements.score.lcp)`,
        `count_scores(measurements.score.fcp)`,
        `count_scores(measurements.score.cls)`,
        `count_scores(measurements.score.inp)`,
        `count_scores(measurements.score.ttfb)`,
        'total_opportunity_score()',
      ],
      name: 'Web Vitals',
      query: [DEFAULT_QUERY_FILTER, search.formatString()].join(' ').trim(),
      version: 2,
      dataset: DiscoverDatasets.METRICS,
    },
    pageFilters.selection
  );

  eventView.sorts = [sort];

  const {data, isLoading, ...rest} = useDiscoverQuery({
    eventView,
    limit: limit ?? 50,
    location,
    orgSlug: organization.slug,
    options: {
      enabled,
      refetchOnWindowFocus: false,
    },
    referrer: 'api.performance.browser.web-vitals.transactions-scores',
  });

  const tableData: RowWithScoreAndOpportunity[] =
    !isLoading && data?.data.length
      ? data.data.map(row => {
          // Map back performance score key so we don't have to handle both keys in the UI
          if (
            shouldUseStaticWeights &&
            row['performance_score(measurements.score.total)'] !== undefined
          ) {
            row['avg(measurements.score.total)'] =
              row['performance_score(measurements.score.total)'];
          }
          const {totalScore, clsScore, fcpScore, lcpScore, ttfbScore, inpScore} =
            calculatePerformanceScoreFromStoredTableDataRow(row);
          return {
            transaction: row.transaction?.toString(),
            'p75(measurements.lcp)': row['p75(measurements.lcp)'] as number,
            'p75(measurements.fcp)': row['p75(measurements.fcp)'] as number,
            'p75(measurements.cls)': row['p75(measurements.cls)'] as number,
            'p75(measurements.ttfb)': row['p75(measurements.ttfb)'] as number,
            'p75(measurements.inp)': row['p75(measurements.inp)'] as number,
            'count()': row['count()'] as number,
            'count_scores(measurements.score.lcp)': row[
              'count_scores(measurements.score.lcp)'
            ] as number,
            'count_scores(measurements.score.fcp)': row[
              'count_scores(measurements.score.fcp)'
            ] as number,
            'count_scores(measurements.score.cls)': row[
              'count_scores(measurements.score.cls)'
            ] as number,
            'count_scores(measurements.score.inp)': row[
              'count_scores(measurements.score.inp)'
            ] as number,
            'count_scores(measurements.score.ttfb)': row[
              'count_scores(measurements.score.ttfb)'
            ] as number,
            totalScore: totalScore ?? 0,
            clsScore: clsScore ?? 0,
            fcpScore: fcpScore ?? 0,
            lcpScore: lcpScore ?? 0,
            ttfbScore: ttfbScore ?? 0,
            inpScore: inpScore ?? 0,
            // Map back opportunity score key so we don't have to handle both keys in the UI
            opportunity: row[
              shouldUseStaticWeights && webVital === 'total'
                ? 'total_opportunity_score()'
                : `opportunity_score(measurements.score.${webVital})`
            ] as number,
          };
        })
      : [];

  return {
    data: tableData,
    isLoading,
    ...rest,
  };
};

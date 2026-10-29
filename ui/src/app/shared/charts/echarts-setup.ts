import { provideEchartsCore } from 'ngx-echarts';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  GraphicComponent,
  GridComponent,
  TooltipComponent,
} from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { SVGRenderer } from 'echarts/renderers';

// Only the parts the dashboard uses (keeps the bundle small); SVG renderer, like the hand-drawn charts it replaces.
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  GraphicComponent,
  LabelLayout,
  SVGRenderer,
]);

export const provideCharts = () => provideEchartsCore({ echarts });

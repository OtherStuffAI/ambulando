import { indexTasks, projectTree } from './task-tree-graph.js';
self.onmessage = ({data}) => {
  const {key, generation, rows, root, options} = data;
  self.postMessage({key,generation,graph:projectTree(indexTasks(rows),root,options)});
};

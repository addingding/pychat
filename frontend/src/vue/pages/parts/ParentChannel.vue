<template>
  <select class="input" :value="value" @change="onchange">
    <option :value="null" selected>W/o channel</option>
    <option
        v-for="channel in channels"
        :key="channel.id"
        :value="channel.id"
    >
      {{ channel.name }}
    </option>
  </select>
</template>
<script lang="ts">
import {
  Component,
  Emit,
  Prop,
  Vue
} from 'vue-property-decorator';
import { State } from '@/ts/instances/storeInstance';
import { ChannelUIModel } from '@/ts/types/model';

@Component({name: 'ParentChannel'})
 export default class ParentChannel extends Vue {
    @State
    public readonly channels!: ChannelUIModel[];

    @Prop({default: null})
    public readonly value!: number;

    public onchange(e: Event) {
      this.input(e);
    }

    @Emit()
    public input(e: Event) {
      let target: HTMLSelectElement = e.target as HTMLSelectElement;
      if (target.value) {
        return parseInt(target.value)
      } else {
        return null
      }
    }
  }
</script>
<!-- eslint-disable -->
<style
    lang="sass"
    scoped
>
  select
    width: 100%
</style>
